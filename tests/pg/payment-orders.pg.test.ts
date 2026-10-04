import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCashAccount, insertCompanyMember, seedCompany } from './fixtures'

// pg-real coverage for 20261004010200_payment_orders.sql: create_payment_orders
// (happy path, idempotent replay, every refusal code, the member write-role
// guard, the sandbox refusal), the one-open-order-per-invoice rule in both directions against file
// batches, the lifecycle trigger (status moves, the instruction frozen after
// draft, write-once provider ids, settlement only on executed orders), the
// append-only event log, and RLS (members read, nobody writes directly).

const DEBTOR = {
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
  name: 'Företagskonto',
  currency: 'SEK',
  bank_name: 'SEB',
}

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro)
     VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(params: {
  companyId: string
  userId: string
  supplierId: string
  status?: string
  currency?: string
  remaining?: number
  isCreditNote?: boolean
}): Promise<string> {
  const id = randomUUID()
  const remaining = params.remaining ?? 737.5
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status, currency, is_credit_note)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-09-20', '2026-10-20',
             590, 147.5, 737.5, $6, $7, $8, $9)`,
    [
      id,
      params.userId,
      params.companyId,
      params.supplierId,
      `CD-${id.slice(0, 8)}`,
      remaining,
      params.status ?? 'approved',
      params.currency ?? 'SEK',
      params.isCreditNote ?? false,
    ],
  )
  return id
}

function orderPayload(params: {
  supplierInvoiceId: string
  cashAccountId: string
  amount?: number
  currency?: string
  idempotencyKey?: string
}) {
  return {
    supplier_invoice_id: params.supplierInvoiceId,
    amount: params.amount ?? 737.5,
    currency: params.currency ?? 'SEK',
    requested_execution_date: '2026-10-20',
    cash_account_id: params.cashAccountId,
    debtor_snapshot: DEBTOR,
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_name: 'Derome Bygg AB',
    payee_source: 'invoice',
    payee_check: 'known',
    reference_type: 'ocr',
    reference: '4400112233',
    idempotency_key: params.idempotencyKey ?? randomUUID(),
  }
}

async function seedPayable(overrides: { status?: string; currency?: string; remaining?: number; isCreditNote?: boolean } = {}) {
  const ctx = await seedCompany()
  const supplierId = await insertSupplier(ctx.companyId, ctx.userId)
  const invoiceId = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId, ...overrides })
  const cashAccountId = await insertCashAccount({
    companyId: ctx.companyId,
    ledgerAccount: '1930',
    iban: DEBTOR.iban,
    source: 'enable_banking',
  })
  return { ...ctx, supplierId, invoiceId, cashAccountId }
}

// Service-role style call: no JWT claims on the superuser pool, so the RPC
// takes p_user_id as the actor (the route authenticated the user in code).
async function createOrders(companyId: string, userId: string, orders: unknown[]) {
  const { rows } = await getPool().query<{ result: { ok: boolean; code?: string; orders?: Array<Record<string, unknown>>; details?: unknown } }>(
    `SELECT public.create_payment_orders($1, $2::jsonb, $3) AS result`,
    [companyId, JSON.stringify(orders), userId],
  )
  return rows[0]!.result
}

async function createOneOrder(ctx: { companyId: string; userId: string; invoiceId: string; cashAccountId: string }) {
  const result = await createOrders(ctx.companyId, ctx.userId, [
    orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId }),
  ])
  expect(result.ok).toBe(true)
  return result.orders![0]! as { id: string; status: string; end_to_end_id: string }
}

async function setStatus(orderId: string, status: string, extra = '') {
  await getPool().query(`UPDATE public.payment_orders SET status = $2 ${extra} WHERE id = $1`, [orderId, status])
}

describe('create_payment_orders', () => {
  it('creates a draft order with a generated end-to-end id and a created event', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)

    expect(order.status).toBe('draft')
    expect(order.end_to_end_id).toMatch(/^ACC[0-9a-f]{32}$/)

    const events = await getPool().query(
      `SELECT event_type, to_status FROM public.payment_order_events WHERE payment_order_id = $1`,
      [order.id],
    )
    expect(events.rows).toEqual([{ event_type: 'created', to_status: 'draft' }])
  })

  it('refuses a sandbox company, even when called directly', async () => {
    const ctx = await seedPayable()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, true)
       ON CONFLICT (company_id) DO UPDATE SET is_sandbox = true`,
      [ctx.userId, ctx.companyId],
    )

    const result = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId }),
    ])

    expect(result).toMatchObject({ ok: false, code: 'sandbox' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_orders WHERE company_id = $1`, [ctx.companyId])
    expect(rows[0].n).toBe(0)
  })

  it('returns the existing order when an idempotency key is replayed', async () => {
    const ctx = await seedPayable()
    const payload = orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, idempotencyKey: 'op-replay-1' })
    const first = await createOrders(ctx.companyId, ctx.userId, [payload])
    const second = await createOrders(ctx.companyId, ctx.userId, [payload])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.orders).toHaveLength(1)
    expect(second.orders![0]!.id).toBe(first.orders![0]!.id)
    const count = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_orders WHERE company_id = $1`, [ctx.companyId])
    expect(count.rows[0].n).toBe(1)
  })

  it('refuses an amount above what remains on the invoice', async () => {
    const ctx = await seedPayable({ remaining: 100 })
    const result = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, amount: 737.5 }),
    ])
    expect(result).toMatchObject({ ok: false, code: 'amount_exceeds_remaining' })
  })

  it('refuses paid invoices and credit notes', async () => {
    const paid = await seedPayable({ status: 'paid', remaining: 0 })
    const paidResult = await createOrders(paid.companyId, paid.userId, [
      orderPayload({ supplierInvoiceId: paid.invoiceId, cashAccountId: paid.cashAccountId, amount: 1 }),
    ])
    expect(paidResult).toMatchObject({ ok: false, code: 'ineligible' })

    // supplier_invoices_credit_note_not_payable keeps new credit notes out of
    // the payable statuses; the RPC's own credit-note check is the defense for
    // rows that predate that NOT VALID constraint.
    const credit = await seedPayable({ isCreditNote: true, status: 'credited' })
    const creditResult = await createOrders(credit.companyId, credit.userId, [
      orderPayload({ supplierInvoiceId: credit.invoiceId, cashAccountId: credit.cashAccountId }),
    ])
    expect(creditResult).toMatchObject({ ok: false, code: 'ineligible' })
    expect(JSON.stringify(creditResult.details)).toContain('credit_note')
  })

  it('refuses paying in another currency than the invoice', async () => {
    const ctx = await seedPayable({ currency: 'EUR' })
    const result = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, currency: 'SEK' }),
    ])
    expect(result).toMatchObject({ ok: false, code: 'currency_mismatch' })
  })

  it('refuses a second open order for the same invoice', async () => {
    const ctx = await seedPayable()
    await createOneOrder(ctx)
    const again = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId }),
    ])
    expect(again).toMatchObject({ ok: false, code: 'already_in_payment' })
  })

  it('refuses a cash account from another company', async () => {
    const ctx = await seedPayable()
    const other = await seedCompany()
    const foreignAccount = await insertCashAccount({ companyId: other.companyId, ledgerAccount: '1930' })
    await expect(
      createOrders(ctx.companyId, ctx.userId, [orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: foreignAccount })]),
    ).rejects.toThrow(/fk_payment_orders_cash_account/)
  })

  it('refuses a viewer and a non-member', async () => {
    const ctx = await seedPayable()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })
    await expect(
      createOrders(ctx.companyId, viewer, [orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId })]),
    ).rejects.toThrow(/no write role/)

    const stranger = await insertAuthUser()
    await expect(
      withUserContext(stranger, (client) =>
        client.query(`SELECT public.create_payment_orders($1, $2::jsonb)`, [
          ctx.companyId,
          JSON.stringify([orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId })]),
        ]),
      ),
    ).rejects.toThrow(/not a member/)
  })

  it('pins the actor to the JWT user for a browser session', async () => {
    const ctx = await seedPayable()
    const other = await insertAuthUser()
    const result = await withUserContext(ctx.userId, async (client) => {
      const { rows } = await client.query(`SELECT public.create_payment_orders($1, $2::jsonb, $3) AS result`, [
        ctx.companyId,
        JSON.stringify([orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId })]),
        other,
      ])
      return rows[0].result
    })
    expect(result.ok).toBe(true)
    expect(result.orders[0].user_id).toBe(ctx.userId)
  })
})

describe('a file batch and a bank payment never cover the same invoice', () => {
  async function insertBatchWithItem(companyId: string, userId: string, invoiceId: string) {
    const batchId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_payment_batches
         (id, company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
       VALUES ($1, $2, $3, 'pain001', 737.5, 1, $4, $5)`,
      [batchId, companyId, userId, `ACCOUNTED-B${batchId.slice(0, 8)}`, JSON.stringify(DEBTOR)],
    )
    await getPool().query(
      `INSERT INTO public.supplier_payment_batch_items
         (batch_id, company_id, supplier_invoice_id, amount, payment_date,
          payee_type, payee_bankgiro, payee_name, reference_type, reference)
       VALUES ($1, $2, $3, 737.5, '2026-10-20', 'bankgiro', '50501055', 'Derome Bygg AB', 'ocr', '4400112233')`,
      [batchId, companyId, invoiceId],
    )
    return batchId
  }

  it('refuses an order for an invoice in an open file batch', async () => {
    const ctx = await seedPayable()
    await insertBatchWithItem(ctx.companyId, ctx.userId, ctx.invoiceId)
    const result = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId }),
    ])
    expect(result).toMatchObject({ ok: false, code: 'in_payment_file' })
  })

  it('allows an order once the file batch is cancelled', async () => {
    const ctx = await seedPayable()
    const batchId = await insertBatchWithItem(ctx.companyId, ctx.userId, ctx.invoiceId)
    await getPool().query(
      `UPDATE public.supplier_payment_batches SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [batchId],
    )
    const order = await createOneOrder(ctx)
    expect(order.status).toBe('draft')
  })

  it('refuses a file batch item for an invoice with an open order', async () => {
    const ctx = await seedPayable()
    await createOneOrder(ctx)
    await expect(insertBatchWithItem(ctx.companyId, ctx.userId, ctx.invoiceId)).rejects.toThrow(/already has an open bank payment/)
  })

  it('allows a file batch item once the order is cancelled', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'cancelled')
    await expect(insertBatchWithItem(ctx.companyId, ctx.userId, ctx.invoiceId)).resolves.toBeTruthy()
  })
})

describe('payment order lifecycle', () => {
  it('follows draft -> approved -> submitted -> awaiting_signature -> accepted -> executed', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved', ', approved_by = user_id, approved_at = now()')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-1'`)
    await setStatus(order.id, 'awaiting_signature')
    await setStatus(order.id, 'accepted')
    await setStatus(order.id, 'executed', ', executed_at = now()')
    const { rows } = await getPool().query(`SELECT status FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(rows[0].status).toBe('executed')
  })

  it('refuses skipping approval and moving out of a final status', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await expect(setStatus(order.id, 'submitted', `, provider = 'open_payments'`)).rejects.toThrow(/cannot move to/)

    await setStatus(order.id, 'cancelled', ', cancelled_at = now()')
    await expect(setStatus(order.id, 'draft')).rejects.toThrow(/cannot move to/)
  })

  it('requires a provider once the bank has the payment', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    await expect(setStatus(order.id, 'submitted')).rejects.toThrow(/payment_orders_provider_once_submitted/)
  })

  it('freezes the instruction after draft and thaws it when un-approved', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await getPool().query(`UPDATE public.payment_orders SET amount = 700 WHERE id = $1`, [order.id])

    await setStatus(order.id, 'approved')
    await expect(
      getPool().query(`UPDATE public.payment_orders SET amount = 600 WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/only change while the order is a draft/)
    await expect(
      getPool().query(`UPDATE public.payment_orders SET payee_bankgiro = '9999999' WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/only change while the order is a draft/)

    await setStatus(order.id, 'draft')
    await getPool().query(`UPDATE public.payment_orders SET amount = 600 WHERE id = $1`, [order.id])
    const { rows } = await getPool().query(`SELECT amount FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(Number(rows[0].amount)).toBe(600)
  })

  it('keeps identity and provider ids immutable', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await expect(
      getPool().query(`UPDATE public.payment_orders SET end_to_end_id = 'X' WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/identity columns are immutable/)

    await setStatus(order.id, 'approved')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-2'`)
    await expect(
      getPool().query(`UPDATE public.payment_orders SET provider_payment_id = 'op-pay-3' WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/written once/)
  })

  it('accepts settlement only on an executed order, and an executed unmatched order still blocks a new one', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-4'`)

    const paymentRowId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments (id, supplier_invoice_id, payment_date, amount, currency, company_id, user_id)
       VALUES ($1, $2, '2026-10-20', 737.5, 'SEK', $3, $4)`,
      [paymentRowId, ctx.invoiceId, ctx.companyId, ctx.userId],
    )
    await expect(
      getPool().query(`UPDATE public.payment_orders SET supplier_invoice_payment_id = $2 WHERE id = $1`, [order.id, paymentRowId]),
    ).rejects.toThrow(/payment_orders_settlement_only_when_executed/)

    await setStatus(order.id, 'executed', ', executed_at = now()')
    const blocked = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, amount: 10 }),
    ])
    expect(blocked).toMatchObject({ ok: false, code: 'already_in_payment' })

    await getPool().query(
      `UPDATE public.payment_orders SET supplier_invoice_payment_id = $2, matched_at = now() WHERE id = $1`,
      [order.id, paymentRowId],
    )
    const next = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, amount: 10 }),
    ])
    expect(next.ok).toBe(true)
  })
})

describe('payment order batches (one signing)', () => {
  async function insertBatch(companyId: string, userId: string, target: 'payment' | 'basket', orderCount: number) {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.payment_order_batches
         (id, company_id, user_id, provider, signing_target, order_count, total_amount, currency)
       VALUES ($1, $2, $3, 'open_payments', $4, $5, 1000, 'SEK')`,
      [id, companyId, userId, target, orderCount],
    )
    return id
  }

  it('keeps a basket for several orders and a payment signing for exactly one', async () => {
    const ctx = await seedCompany()
    await expect(insertBatch(ctx.companyId, ctx.userId, 'basket', 1)).rejects.toThrow(/basket_needs_orders/)
    await expect(insertBatch(ctx.companyId, ctx.userId, 'payment', 2)).rejects.toThrow(/single_payment/)
    await expect(insertBatch(ctx.companyId, ctx.userId, 'basket', 2)).resolves.toBeTruthy()
    await expect(insertBatch(ctx.companyId, ctx.userId, 'payment', 1)).resolves.toBeTruthy()
  })

  it('lets an abandoned signing start again, writes the basket id once, and ends in final statuses', async () => {
    const ctx = await seedCompany()
    const id = await insertBatch(ctx.companyId, ctx.userId, 'basket', 2)
    const update = (sql: string) => getPool().query(`UPDATE public.payment_order_batches SET ${sql} WHERE id = $1`, [id])

    await update(`provider_batch_id = 'basket-1', status = 'awaiting_signature', provider_authorisation_id = 'auth-1'`)
    await update(`status = 'created'`)
    await update(`status = 'awaiting_signature', provider_authorisation_id = 'auth-2'`)
    await expect(update(`provider_batch_id = 'basket-2'`)).rejects.toThrow(/written once/)
    await update(`status = 'signed', signed_at = now()`)
    await expect(update(`status = 'created'`)).rejects.toThrow(/cannot move to/)
    await expect(update(`order_count = 3`)).rejects.toThrow(/immutable/)
  })
})

describe('claim_payment_orders_for_signing', () => {
  async function claim(companyId: string, userId: string, orderIds: string[]) {
    const { rows } = await getPool().query<{ result: { ok: boolean; code?: string; batch?: Record<string, unknown>; orders?: Array<Record<string, unknown>> } }>(
      `SELECT public.claim_payment_orders_for_signing($1, $2::uuid[], 'open_payments', $3) AS result`,
      [companyId, orderIds, userId],
    )
    return rows[0]!.result
  }

  async function twoApprovedOrders() {
    const ctx = await seedPayable()
    const secondInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    const first = await createOneOrder(ctx)
    const second = await createOneOrder({ ...ctx, invoiceId: secondInvoice })
    await setStatus(first.id, 'approved')
    await setStatus(second.id, 'approved')
    return { ...ctx, orderIds: [first.id, second.id] }
  }

  it('moves approved orders to submitted under one basket signing, with events', async () => {
    const ctx = await twoApprovedOrders()
    const result = await claim(ctx.companyId, ctx.userId, ctx.orderIds)
    expect(result.ok).toBe(true)
    expect(result.batch).toMatchObject({ signing_target: 'basket', order_count: 2, status: 'created', provider: 'open_payments' })
    expect(Number(result.batch!.total_amount)).toBe(1475)
    for (const order of result.orders!) {
      expect(order).toMatchObject({ status: 'submitted', provider: 'open_payments', batch_id: result.batch!.id, submitted_by: ctx.userId })
    }
    const events = await getPool().query(
      `SELECT count(*)::int AS n FROM public.payment_order_events WHERE batch_id = $1 AND event_type = 'submitted'`,
      [result.batch!.id],
    )
    expect(events.rows[0].n).toBe(2)
  })

  it('signs a single order as the payment itself', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    const result = await claim(ctx.companyId, ctx.userId, [order.id])
    expect(result.batch).toMatchObject({ signing_target: 'payment', order_count: 1 })
  })

  it('claims nothing when one order is not approved, and a second claim of the same orders fails', async () => {
    const ctx = await twoApprovedOrders()
    await setStatus(ctx.orderIds[1]!, 'draft')
    const refused = await claim(ctx.companyId, ctx.userId, ctx.orderIds)
    expect(refused).toMatchObject({ ok: false, code: 'not_approved' })
    const { rows } = await getPool().query(`SELECT status FROM public.payment_orders WHERE id = $1`, [ctx.orderIds[0]])
    expect(rows[0].status).toBe('approved')

    await setStatus(ctx.orderIds[1]!, 'approved')
    expect((await claim(ctx.companyId, ctx.userId, ctx.orderIds)).ok).toBe(true)
    expect(await claim(ctx.companyId, ctx.userId, ctx.orderIds)).toMatchObject({ ok: false, code: 'not_approved' })
  })

  it('refuses orders from different accounts, unknown orders and a viewer', async () => {
    const ctx = await twoApprovedOrders()
    const otherAccount = await insertCashAccount({ companyId: ctx.companyId, ledgerAccount: '1931', iban: 'SE4550000000058398257466' })
    await getPool().query(`UPDATE public.payment_orders SET status = 'draft' WHERE id = $1`, [ctx.orderIds[1]])
    await getPool().query(`UPDATE public.payment_orders SET cash_account_id = $2 WHERE id = $1`, [ctx.orderIds[1], otherAccount])
    await setStatus(ctx.orderIds[1]!, 'approved')
    expect(await claim(ctx.companyId, ctx.userId, ctx.orderIds)).toMatchObject({ ok: false, code: 'mixed_accounts' })
    expect(await claim(ctx.companyId, ctx.userId, [randomUUID()])).toMatchObject({ ok: false, code: 'not_found' })

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })
    await expect(claim(ctx.companyId, viewer, [ctx.orderIds[0]!])).rejects.toThrow(/no write role/)
  })
})

describe('payment order events', () => {
  it('are append-only', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await expect(
      getPool().query(`UPDATE public.payment_order_events SET event_type = 'error' WHERE payment_order_id = $1`, [order.id]),
    ).rejects.toThrow(/append-only/)
  })
})

describe('payment orders RLS', () => {
  it('lets members read their company rows and strangers nothing', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    const stranger = await insertAuthUser()

    const own = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.payment_orders WHERE id = $1`, [order.id]),
    )
    expect(own.rows).toHaveLength(1)
    const ownEvents = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.payment_order_events WHERE payment_order_id = $1`, [order.id]),
    )
    expect(ownEvents.rows).toHaveLength(1)

    const theirs = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.payment_orders WHERE id = $1`, [order.id]),
    )
    expect(theirs.rows).toHaveLength(0)
  })

  it('refuses direct writes from a browser session, even for the owner', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await expect(
      withUserContext(ctx.userId, (client) =>
        client.query(`UPDATE public.payment_orders SET status = 'approved' WHERE id = $1`, [order.id]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(ctx.userId, (client) =>
        client.query(
          `INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type) VALUES ($1, $2, 'error')`,
          [ctx.companyId, order.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/)
  })
})
