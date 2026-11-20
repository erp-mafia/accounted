import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCashAccount, insertCompanyMember, seedCompany } from './fixtures'

// pg-real coverage for 20261010090000_payment_orders.sql: create_payment_orders
// (happy path, idempotent replay and its mismatch, every refusal code, the
// member write-role guard, the sandbox refusal, EXECUTE for the service role
// only, the payee checked against its source and its check derived), the
// one-open-order-per-invoice rule in both directions against file batches, the
// lifecycle trigger (status moves, the instruction frozen after draft,
// write-once provider ids, an unknown bank outcome only resolved by a debit or
// a person, back to approved only when the bank holds nothing, settlement only
// on executed orders), the claim's invoice recheck, the cancel of unsent
// orders when the invoice closes, the rebatch of a signing, the delete and
// truncate guards, the audit log ignoring polls, and RLS (members read,
// nobody writes directly).

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
  payeeSource?: 'invoice' | 'supplier'
  bankgiro?: string
}) {
  return {
    supplier_invoice_id: params.supplierInvoiceId,
    amount: params.amount ?? 737.5,
    currency: params.currency ?? 'SEK',
    requested_execution_date: '2026-10-20',
    cash_account_id: params.cashAccountId,
    debtor_snapshot: DEBTOR,
    payee_type: 'bankgiro',
    payee_bankgiro: params.bankgiro ?? '50501055',
    payee_name: 'Derome Bygg AB',
    payee_source: params.payeeSource ?? 'supplier',
    // Ignored: the function derives the check itself.
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

  it('refuses a viewer, a non-member and any browser session', async () => {
    const ctx = await seedPayable()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })
    await expect(
      createOrders(ctx.companyId, viewer, [orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId })]),
    ).rejects.toThrow(/no write role/)

    const stranger = await insertAuthUser()
    await expect(
      createOrders(ctx.companyId, stranger, [orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId })]),
    ).rejects.toThrow(/no write role/)

    // EXECUTE belongs to the service role: a member's own JWT (a PostgREST
    // call that would skip the route, its MFA and its payee confirmation) is
    // refused before the function runs.
    for (const fn of [
      `SELECT public.create_payment_orders($1, '[]'::jsonb)`,
      `SELECT public.claim_payment_orders_for_signing($1, ARRAY[]::uuid[], 'open_payments')`,
      `SELECT public.rebatch_payment_orders_for_signing($1, gen_random_uuid())`,
    ]) {
      await expect(withUserContext(ctx.userId, (client) => client.query(fn, [ctx.companyId]))).rejects.toThrow(
        /permission denied for function/,
      )
    }
  })

  it('refuses an idempotency key reused for another invoice and a key used twice in one call', async () => {
    const ctx = await seedPayable()
    const secondInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    const first = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, idempotencyKey: 'key-a' }),
    ])
    expect(first.ok).toBe(true)

    const reused = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: secondInvoice, cashAccountId: ctx.cashAccountId, idempotencyKey: 'key-a' }),
    ])
    expect(reused).toMatchObject({ ok: false, code: 'idempotency_mismatch' })

    const twice = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: secondInvoice, cashAccountId: ctx.cashAccountId, idempotencyKey: 'key-b' }),
      orderPayload({ supplierInvoiceId: randomUUID(), cashAccountId: ctx.cashAccountId, idempotencyKey: 'key-b' }),
    ])
    expect(twice).toMatchObject({ ok: false, code: 'invalid_payload' })
  })
})

describe('the payee of an order', () => {
  async function stateOnInvoice(invoiceId: string, bankgiro: string) {
    await getPool().query(`UPDATE public.supplier_invoices SET payee_bankgiro = $2 WHERE id = $1`, [invoiceId, bankgiro])
  }

  it('refuses an account its source does not name, whatever check the caller claims', async () => {
    const ctx = await seedPayable()
    // The supplier card says 5050-1055; the caller claims 9999-9999 from the card and calls it known.
    const result = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, bankgiro: '99999999' }),
    ])
    expect(result).toMatchObject({ ok: false, code: 'payee_mismatch' })

    // Nor may it claim the invoice states an account the invoice does not state.
    const fromInvoice = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, payeeSource: 'invoice' }),
    ])
    expect(fromInvoice).toMatchObject({ ok: false, code: 'payee_mismatch' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_orders WHERE company_id = $1`, [ctx.companyId])
    expect(rows[0].n).toBe(0)
  })

  async function payeeCheck(orderId: string) {
    const { rows } = await getPool().query(`SELECT payee_check FROM public.payment_orders WHERE id = $1`, [orderId])
    return rows[0].payee_check as string
  }

  it('calls an account known only once a person approved an order to it that reached the bank', async () => {
    const ctx = await seedPayable()
    const first = await createOneOrder(ctx)
    // The card's bankgiro was never confirmed by a payment: the payload's 'known' is ignored.
    expect(await payeeCheck(first.id)).toBe('new')

    // A person approved it, but it never reached the bank: that confirms nothing yet.
    await setStatus(first.id, 'approved', ', approved_by = user_id, approved_at = now()')
    const secondInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    expect(await payeeCheck((await createOneOrder({ ...ctx, invoiceId: secondInvoice })).id)).toBe('new')

    // The bank holds its payment: the account a person approved is known.
    await setStatus(first.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-known', submitted_at = now()`)
    const thirdInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    expect(await payeeCheck((await createOneOrder({ ...ctx, invoiceId: thirdInvoice })).id)).toBe('known')
  })

  it('never calls an account known from an order no person approved, whatever reached the bank', async () => {
    const ctx = await seedPayable()
    const first = await createOneOrder(ctx)
    await setStatus(first.id, 'approved', ', approved_at = now()')
    await setStatus(first.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-agent', submitted_at = now()`)
    const secondInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    expect(await payeeCheck((await createOneOrder({ ...ctx, invoiceId: secondInvoice })).id)).toBe('new')
  })

  it('never calls an account known from a payment file: a file records no person who confirmed it', async () => {
    const ctx = await seedPayable()
    const earlierInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    const batchId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_payment_batches
         (id, company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot, status, cancelled_at)
       VALUES ($1, $2, $3, 'pain001', 737.5, 1, $4, $5, 'created', NULL)`,
      [batchId, ctx.companyId, ctx.userId, `ACCOUNTED-K${batchId.slice(0, 8)}`, JSON.stringify(DEBTOR)],
    )
    await getPool().query(
      `INSERT INTO public.supplier_payment_batch_items
         (batch_id, company_id, supplier_invoice_id, amount, payment_date,
          payee_type, payee_bankgiro, payee_name, reference_type, reference)
       VALUES ($1, $2, $3, 737.5, '2026-10-20', 'bankgiro', '50501055', 'Derome Bygg AB', 'ocr', '4400112233')`,
      [batchId, ctx.companyId, earlierInvoice],
    )
    await getPool().query(`UPDATE public.supplier_payment_batches SET file_generated_at = now(), download_count = 1 WHERE id = $1`, [batchId])
    const order = await createOneOrder(ctx)
    expect(await payeeCheck(order.id)).toBe('new')
  })

  it('calls it changed when the invoice states another account than the card, whichever is paid', async () => {
    const ctx = await seedPayable()
    await stateOnInvoice(ctx.invoiceId, '5402-0102')
    const payCard = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId }),
    ])
    expect(payCard.ok).toBe(true)
    expect(payCard.orders![0]!.payee_check).toBe('changed')
    await setStatus(payCard.orders![0]!.id as string, 'cancelled', ', cancelled_at = now()')

    const payInvoice = await createOrders(ctx.companyId, ctx.userId, [
      orderPayload({ supplierInvoiceId: ctx.invoiceId, cashAccountId: ctx.cashAccountId, payeeSource: 'invoice', bankgiro: '54020102' }),
    ])
    expect(payInvoice.ok).toBe(true)
    expect(payInvoice.orders![0]!).toMatchObject({ payee_check: 'changed', payee_source: 'invoice', payee_bankgiro: '54020102' })
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

  it('keeps an order whose bank outcome is unknown open until its debit or a person resolves it', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', submitted_at = now()`)
    // Only a submitted order without a payment id can carry the marker.
    await expect(
      getPool().query(`UPDATE public.payment_orders SET provider_payment_id = 'x', outcome_unknown_at = now() WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/payment_orders_outcome_unknown_scope/)
    await getPool().query(`UPDATE public.payment_orders SET outcome_unknown_at = now() WHERE id = $1`, [order.id])

    for (const to of ['failed', 'approved']) {
      await expect(
        getPool().query(`UPDATE public.payment_orders SET status = $2, outcome_unknown_at = NULL, batch_id = NULL WHERE id = $1`, [order.id, to]),
      ).rejects.toThrow(/outcome is unknown/)
    }
    await expect(
      getPool().query(`UPDATE public.payment_orders SET status = 'cancelled', outcome_unknown_at = NULL, cancelled_at = now() WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/outcome is unknown/)
    await expect(
      getPool().query(`UPDATE public.payment_orders SET outcome_unknown_at = NULL WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/cleared only together with the bank's payment id/)

    // A person who confirms the payment never reached the bank may cancel it.
    await getPool().query(
      `UPDATE public.payment_orders SET status = 'cancelled', outcome_unknown_at = NULL, cancelled_at = now(), cancelled_by = $2 WHERE id = $1`,
      [order.id, ctx.userId],
    )
    const { rows } = await getPool().query(`SELECT status FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(rows[0].status).toBe('cancelled')
  })

  it('goes back to approved only when the bank holds nothing for the order', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-9', submitted_at = now()`)

    const release = () =>
      getPool().query(
        `UPDATE public.payment_orders SET status = 'approved', provider_payment_id = NULL, batch_id = NULL WHERE id = $1`,
        [order.id],
      )
    await expect(
      getPool().query(`UPDATE public.payment_orders SET status = 'approved' WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/bank holds no payment/)
    // Without the bank's confirmed cancel of exactly this payment the id stays.
    await expect(release()).rejects.toThrow(/cleared only after the bank confirmed its cancel/)
    await getPool().query(
      `INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, detail)
       VALUES ($1, $2, 'provider_cancelled', '{"provider_payment_id": "op-pay-other"}')`,
      [ctx.companyId, order.id],
    )
    await expect(release()).rejects.toThrow(/cleared only after the bank confirmed its cancel/)
    await getPool().query(
      `INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, detail)
       VALUES ($1, $2, 'provider_cancelled', '{"provider_payment_id": "op-pay-9"}')`,
      [ctx.companyId, order.id],
    )
    await release()
    const { rows } = await getPool().query(`SELECT status, provider_payment_id, submitted_at FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(rows[0]).toMatchObject({ status: 'approved', provider_payment_id: null })
    // The claim is remembered: an order that was sent to a bank is kept.
    expect(rows[0].submitted_at).not.toBeNull()
  })

  it('starts a create only on a claimed order the bank holds nothing for, and moves nothing while it runs', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    const update = (sql: string) => getPool().query(`UPDATE public.payment_orders SET ${sql} WHERE id = $1`, [order.id])
    await expect(update('create_started_at = now()')).rejects.toThrow(/a create starts only on a claimed order/)

    await setStatus(order.id, 'approved')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', submitted_at = now()`)
    await update('create_started_at = now()')

    // While the bank is being asked, nothing releases, cancels or re-signs the order.
    for (const move of [
      `status = 'approved', batch_id = NULL`,
      `status = 'cancelled', cancelled_at = now(), cancelled_by = user_id`,
      `status = 'failed'`,
      `create_started_at = now() - interval '1 minute'`,
    ]) {
      await expect(update(move)).rejects.toThrow(/nothing moves an order while its create is in flight/)
    }
    // It ends only with what the bank answered.
    await expect(update('create_started_at = NULL')).rejects.toThrow(/ends only with what the bank answered/)
    await expect(update(`create_started_at = NULL, status = 'approved', batch_id = NULL`)).rejects.toThrow(/ends only with what the bank answered/)
    await update(`create_started_at = NULL, provider_payment_id = 'op-pay-wa1'`)
    const { rows } = await getPool().query(`SELECT create_started_at, provider_payment_id FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(rows[0]).toEqual({ create_started_at: null, provider_payment_id: 'op-pay-wa1' })
  })

  it('ends a create with a refusal, a failure before sending or an unknown outcome', async () => {
    const ctx = await seedPayable()
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const invoiceId = i === 0 ? ctx.invoiceId : await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
      const order = await createOneOrder({ ...ctx, invoiceId })
      await setStatus(order.id, 'approved')
      await setStatus(order.id, 'submitted', `, provider = 'open_payments', submitted_at = now()`)
      await getPool().query(`UPDATE public.payment_orders SET create_started_at = now() WHERE id = $1`, [order.id])
      ids.push(order.id)
    }
    const [refused, notSent, unknown] = ids as [string, string, string]
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = NULL, status = 'failed', provider_error_code = 'FORMAT_ERROR' WHERE id = $1`, [refused])
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = NULL, status = 'approved', provider_error_code = 'RATE_LIMITED' WHERE id = $1`, [notSent])
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = NULL, outcome_unknown_at = now(), provider_error_code = 'TIMEOUT' WHERE id = $1`, [unknown])
    const { rows } = await getPool().query(
      `SELECT id, status, create_started_at, outcome_unknown_at IS NOT NULL AS unknown FROM public.payment_orders WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.create_started_at, r.unknown]]))).toEqual({
      [refused]: ['failed', null, false],
      [notSent]: ['approved', null, false],
      [unknown]: ['submitted', null, true],
    })
  })

  it('cancels a claimed order without a payment id only for a person, once its outcome is unknown', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', submitted_at = now()`)
    const cancel = (extra: string) =>
      getPool().query(`UPDATE public.payment_orders SET status = 'cancelled', cancelled_at = now() ${extra} WHERE id = $1`, [order.id])

    // Its create may be on its way to the bank: even a person cannot cancel it yet.
    await expect(cancel(', cancelled_by = user_id')).rejects.toThrow(/cancelled only by a person, once its bank outcome is unknown/)
    await getPool().query(`UPDATE public.payment_orders SET outcome_unknown_at = now() WHERE id = $1`, [order.id])
    await expect(cancel(', outcome_unknown_at = NULL')).rejects.toThrow(/outcome is unknown/)
    await cancel(', outcome_unknown_at = NULL, cancelled_by = user_id')
    const { rows } = await getPool().query(`SELECT status FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(rows[0].status).toBe('cancelled')
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

  it('records a payment recreated after an expired signing, and still refuses an event type it does not know', async () => {
    const ctx = await seedCompany()
    const id = await insertBatch(ctx.companyId, ctx.userId, 'basket', 2)
    const insert = (type: string) =>
      getPool().query(
        `INSERT INTO public.payment_order_events (company_id, batch_id, event_type, detail)
         VALUES ($1, $2, $3, '{"previous_batch_id": "00000000-0000-0000-0000-000000000000", "previous_provider_payment_id": "op-pay-1"}'::jsonb)`,
        [ctx.companyId, id, type],
      )
    await expect(insert('recreated_after_expired_signing')).resolves.toBeTruthy()
    await expect(insert('recreated')).rejects.toThrow(/payment_order_events_event_type_check/)
    const { rows } = await getPool().query(
      `SELECT detail ->> 'previous_provider_payment_id' AS previous FROM public.payment_order_events WHERE batch_id = $1 AND event_type = 'recreated_after_expired_signing'`,
      [id],
    )
    expect(rows).toEqual([{ previous: 'op-pay-1' }])
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

  it('re-checks the invoice: refuses one paid down below the order, disputed or credited since approval', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')

    // A manual payment of 300 left 437.50 to pay; the order still says 737.50.
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'partially_paid', remaining_amount = 437.5 WHERE id = $1`, [ctx.invoiceId])
    const reduced = await claim(ctx.companyId, ctx.userId, [order.id])
    expect(reduced).toMatchObject({ ok: false, code: 'ineligible' })
    expect(JSON.stringify(reduced)).toContain('amount_exceeds_remaining')

    await getPool().query(`UPDATE public.supplier_invoices SET status = 'disputed', remaining_amount = 737.5 WHERE id = $1`, [ctx.invoiceId])
    const disputed = await claim(ctx.companyId, ctx.userId, [order.id])
    expect(disputed).toMatchObject({ ok: false, code: 'ineligible' })
    expect(JSON.stringify(disputed)).toContain('not_payable')

    const { rows } = await getPool().query(`SELECT status FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(rows[0].status).toBe('approved')
  })

  it('cancels unsent orders when their invoice is paid another way, and leaves orders the bank holds alone', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    const sentInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    const sent = await createOneOrder({ ...ctx, invoiceId: sentInvoice })
    await setStatus(sent.id, 'approved')
    await setStatus(sent.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-sent'`)

    // Scenario C: a manual payment marks both invoices paid.
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'paid', remaining_amount = 0 WHERE id = ANY($1::uuid[])`, [[ctx.invoiceId, sentInvoice]])

    const { rows } = await getPool().query(
      `SELECT id, status FROM public.payment_orders WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[order.id, sent.id]],
    )
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [order.id]: 'cancelled', [sent.id]: 'submitted' })
    const events = await getPool().query(
      `SELECT detail ->> 'reason' AS reason FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'cancelled'`,
      [order.id],
    )
    expect(events.rows).toEqual([{ reason: 'invoice_paid' }])
    expect(await claim(ctx.companyId, ctx.userId, [order.id])).toMatchObject({ ok: false, code: 'not_approved' })
    // The order the bank holds is left to the bank, and the close is on record.
    const closed = await getPool().query(
      `SELECT from_status, detail ->> 'invoice_status' AS invoice_status, detail ->> 'provider_payment_id' AS payment
         FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'invoice_closed'`,
      [sent.id],
    )
    expect(closed.rows).toEqual([{ from_status: 'submitted', invoice_status: 'paid', payment: 'op-pay-sent' }])
  })

  it('gives an order claimed again a fresh end-to-end id, keeping the old one in its event', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    const first = await claim(ctx.companyId, ctx.userId, [order.id])
    expect(first.orders![0]!.end_to_end_id).toBe(order.end_to_end_id)

    // Its create never reached the bank: back to approved, then signed again.
    await getPool().query(`UPDATE public.payment_orders SET status = 'approved', batch_id = NULL WHERE id = $1`, [order.id])
    const second = await claim(ctx.companyId, ctx.userId, [order.id])
    const renewed = second.orders![0]!.end_to_end_id as string
    expect(renewed).toMatch(/^ACC[0-9a-f]{32}$/)
    expect(renewed).not.toBe(order.end_to_end_id)
    // submitted_at dates the new claim: the bank payments counter (lib/payments/usage.ts) puts the payment in its month.
    const dated = await getPool().query(`SELECT $1::timestamptz < submitted_at AS later FROM public.payment_orders WHERE id = $2`, [first.orders![0]!.submitted_at, order.id])
    expect(dated.rows[0].later).toBe(true)
    const events = await getPool().query(
      `SELECT detail ->> 'previous_end_to_end_id' AS previous
         FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'submitted' ORDER BY occurred_at`,
      [order.id],
    )
    expect(events.rows.map((r) => r.previous)).toEqual([null, order.end_to_end_id])
    // Outside a new claim it never changes.
    await expect(
      getPool().query(`UPDATE public.payment_orders SET end_to_end_id = 'ACC' || repeat('b', 32) WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/identity columns are immutable/)
  })

  it('maps a mixed currency to its own refusal', async () => {
    const ctx = await twoApprovedOrders()
    await getPool().query(`UPDATE public.payment_orders SET status = 'draft' WHERE id = $1`, [ctx.orderIds[1]])
    await getPool().query(`UPDATE public.supplier_invoices SET currency = 'EUR' WHERE id = (SELECT supplier_invoice_id FROM public.payment_orders WHERE id = $1)`, [ctx.orderIds[1]])
    await getPool().query(`UPDATE public.payment_orders SET currency = 'EUR' WHERE id = $1`, [ctx.orderIds[1]])
    await setStatus(ctx.orderIds[1]!, 'approved')
    expect(await claim(ctx.companyId, ctx.userId, ctx.orderIds)).toMatchObject({ ok: false, code: 'mixed_currency' })
  })
})

describe('rebatch_payment_orders_for_signing', () => {
  async function rebatch(companyId: string, userId: string, batchId: string) {
    const { rows } = await getPool().query<{ result: { ok: boolean; code?: string; batch?: Record<string, unknown>; orders?: Array<Record<string, unknown>> } }>(
      `SELECT public.rebatch_payment_orders_for_signing($1, $2, $3) AS result`,
      [companyId, batchId, userId],
    )
    return rows[0]!.result
  }

  async function signingWithTwoPayments(created: 'both' | 'first' = 'both') {
    const ctx = await seedPayable()
    const secondInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
    const first = await createOneOrder(ctx)
    const second = await createOneOrder({ ...ctx, invoiceId: secondInvoice })
    await setStatus(first.id, 'approved')
    await setStatus(second.id, 'approved')
    const { rows } = await getPool().query(
      `SELECT public.claim_payment_orders_for_signing($1, $2::uuid[], 'open_payments', $3) AS result`,
      [ctx.companyId, [first.id, second.id], ctx.userId],
    )
    const batchId = rows[0].result.batch.id as string
    await getPool().query(
      `UPDATE public.payment_orders SET provider_payment_id = 'pay-' || left(id::text, 8) WHERE batch_id = $1 AND ($2 OR id = $3)`,
      [batchId, created === 'both', first.id],
    )
    return { ...ctx, batchId, firstId: first.id, secondId: second.id, secondInvoice }
  }

  it('starts the same signing again when every payment still waits, after checking its invoices again', async () => {
    const ctx = await signingWithTwoPayments()
    await getPool().query(`UPDATE public.payment_order_batches SET provider_batch_id = 'basket-same' WHERE id = $1`, [ctx.batchId])
    const claimedAt = `SELECT id, submitted_at::text FROM public.payment_orders WHERE batch_id = $1 ORDER BY id`
    const before = await getPool().query(claimedAt, [ctx.batchId])

    const result = await rebatch(ctx.companyId, ctx.userId, ctx.batchId)

    expect(result).toMatchObject({ ok: true, same: true, batch: { id: ctx.batchId, status: 'created' } })
    expect(result.orders!.map((o) => o.id).sort()).toEqual([ctx.firstId, ctx.secondId].sort())
    // Signing again leaves submitted_at: the payments reached the bank when first claimed, and count in that month.
    expect((await getPool().query(claimedAt, [ctx.batchId])).rows).toEqual(before.rows)
    const batches = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_order_batches WHERE company_id = $1`, [ctx.companyId])
    expect(batches.rows[0].n).toBe(1)

    // The same signing is never started for an invoice paid meanwhile.
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'paid', remaining_amount = 0 WHERE id = $1`, [ctx.secondInvoice])
    expect(await rebatch(ctx.companyId, ctx.userId, ctx.batchId)).toMatchObject({ ok: false, code: 'ineligible' })
  })

  it('signs nothing while a create of the signing has not ended', async () => {
    const ctx = await signingWithTwoPayments('first')
    // The second create never started (its request died, or is still running).
    expect(await rebatch(ctx.companyId, ctx.userId, ctx.batchId)).toMatchObject({ ok: false, code: 'create_in_progress', details: [ctx.secondId] })
    // Or it is on its way to the bank.
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = now() WHERE id = $1`, [ctx.secondId])
    expect(await rebatch(ctx.companyId, ctx.userId, ctx.batchId)).toMatchObject({ ok: false, code: 'create_in_progress' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_order_batches WHERE company_id = $1`, [ctx.companyId])
    expect(rows[0].n).toBe(1)
  })

  it('moves the payments still waiting to a new signing when one order dropped out', async () => {
    const ctx = await signingWithTwoPayments()
    await setStatus(ctx.secondId, 'cancelled', ', cancelled_at = now(), cancelled_by = user_id')

    const result = await rebatch(ctx.companyId, ctx.userId, ctx.batchId)

    expect(result.ok).toBe(true)
    expect(result.batch).toMatchObject({ signing_target: 'payment', order_count: 1, status: 'created' })
    expect(result.orders!.map((o) => o.id)).toEqual([ctx.firstId])
    const { rows } = await getPool().query(`SELECT batch_id, status, provider_payment_id FROM public.payment_orders WHERE id = $1`, [ctx.firstId])
    expect(rows[0]).toMatchObject({ batch_id: result.batch!.id, status: 'submitted' })
    expect(rows[0].provider_payment_id).toMatch(/^pay-/)
    const old = await getPool().query(`SELECT status FROM public.payment_order_batches WHERE id = $1`, [ctx.batchId])
    expect(old.rows[0].status).toBe('cancelled')
    const events = await getPool().query(
      `SELECT count(*)::int AS n FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'rebatched'`,
      [ctx.firstId],
    )
    expect(events.rows[0].n).toBe(1)
  })

  it('refuses an invoice paid meanwhile, an active signing and a signing with nothing left to sign', async () => {
    const ctx = await signingWithTwoPayments()
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'paid', remaining_amount = 0 WHERE id = $1`, [ctx.secondInvoice])
    expect(await rebatch(ctx.companyId, ctx.userId, ctx.batchId)).toMatchObject({ ok: false, code: 'ineligible' })

    await getPool().query(`UPDATE public.payment_order_batches SET status = 'awaiting_signature', provider_authorisation_id = 'auth-x' WHERE id = $1`, [ctx.batchId])
    expect(await rebatch(ctx.companyId, ctx.userId, ctx.batchId)).toMatchObject({ ok: false, code: 'not_active' })

    const other = await signingWithTwoPayments()
    await setStatus(other.firstId, 'cancelled', ', cancelled_at = now(), cancelled_by = user_id')
    await setStatus(other.secondId, 'cancelled', ', cancelled_at = now(), cancelled_by = user_id')
    expect(await rebatch(other.companyId, other.userId, other.batchId)).toMatchObject({ ok: false, code: 'nothing_to_sign' })
  })
})

/** One approved order claimed into its own signing; the bank holds paymentId for it when given. */
async function claimedOrder(paymentId: string | null) {
  const ctx = await seedPayable()
  const order = await createOneOrder(ctx)
  await setStatus(order.id, 'approved')
  const { rows } = await getPool().query(
    `SELECT public.claim_payment_orders_for_signing($1, $2::uuid[], 'open_payments', $3) AS result`,
    [ctx.companyId, [order.id], ctx.userId],
  )
  const batchId = rows[0].result.batch.id as string
  if (paymentId) await getPool().query(`UPDATE public.payment_orders SET provider_payment_id = $2 WHERE id = $1`, [order.id, paymentId])
  return { ...ctx, orderId: order.id, batchId }
}

async function eventsOf(orderId: string) {
  const { rows } = await getPool().query(
    `SELECT event_type, detail FROM public.payment_order_events WHERE payment_order_id = $1 ORDER BY occurred_at, event_type`,
    [orderId],
  )
  return rows as Array<{ event_type: string; detail: Record<string, unknown> }>
}

describe('release_payment_order', () => {
  async function release(
    ctx: { companyId: string; orderId: string; batchId: string },
    paymentId: string | null,
    reason: string,
    options: { providerStatus?: string | null; errorCode?: string | null; userId?: string | null; batchId?: string } = {},
  ) {
    const { rows } = await getPool().query(
      `SELECT public.release_payment_order($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
      [ctx.companyId, ctx.orderId, options.batchId ?? ctx.batchId, paymentId, options.providerStatus ?? null, reason, options.errorCode ?? null, options.userId ?? null],
    )
    return rows[0]!.result as { ok: boolean; status?: string; code?: string }
  }

  it('lets go of an order whose payment the bank cancelled, recording the cancel with the release', async () => {
    const ctx = await claimedOrder('op-pay-r1')
    expect(await release(ctx, 'op-pay-r1', 'SIGNING_STOPPED', { providerStatus: 'CANC', userId: ctx.userId })).toEqual({ ok: true, status: 'approved' })

    const { rows } = await getPool().query(`SELECT status, batch_id, provider_payment_id, provider_status FROM public.payment_orders WHERE id = $1`, [ctx.orderId])
    expect(rows[0]).toEqual({ status: 'approved', batch_id: null, provider_payment_id: null, provider_status: 'CANC' })
    const events = await eventsOf(ctx.orderId)
    expect(events.find((e) => e.event_type === 'provider_cancelled')?.detail).toMatchObject({ provider_payment_id: 'op-pay-r1' })
    expect(events.find((e) => e.event_type === 'released')?.detail).toMatchObject({ reason: 'SIGNING_STOPPED', cancelled_payment_id: 'op-pay-r1' })
  })

  it('cancels instead of approving an order whose invoice no longer needs paying', async () => {
    const ctx = await claimedOrder('op-pay-r2')
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'paid', remaining_amount = 0 WHERE id = $1`, [ctx.invoiceId])

    expect(await release(ctx, 'op-pay-r2', 'INVOICE_CLOSED', { providerStatus: 'CANC' })).toEqual({ ok: true, status: 'cancelled' })

    const { rows } = await getPool().query(`SELECT status, cancelled_at FROM public.payment_orders WHERE id = $1`, [ctx.orderId])
    expect(rows[0].status).toBe('cancelled')
    expect(rows[0].cancelled_at).not.toBeNull()
    const events = await eventsOf(ctx.orderId)
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['provider_cancelled', 'released', 'cancelled']))
    expect(events.find((e) => e.event_type === 'cancelled')?.detail).toEqual({ reason: 'invoice_paid' })
  })

  it('refuses an order that moved on, and a create in flight without the bank answer', async () => {
    const ctx = await claimedOrder('op-pay-r3')
    expect(await release(ctx, 'op-pay-other', 'SIGNING_STOPPED')).toEqual({ ok: false, code: 'moved' })
    expect(await release(ctx, 'op-pay-r3', 'SIGNING_STOPPED', { batchId: randomUUID() })).toEqual({ ok: false, code: 'moved' })

    const inFlight = await claimedOrder(null)
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = now() WHERE id = $1`, [inFlight.orderId])
    expect(await release(inFlight, null, 'SIGNING_STOPPED')).toEqual({ ok: false, code: 'create_in_progress' })
    expect(await release(inFlight, null, 'SIGNING_STOPPED', { errorCode: 'RATE_LIMITED' })).toEqual({ ok: true, status: 'approved' })
    const { rows } = await getPool().query(`SELECT create_started_at, provider_error_code FROM public.payment_orders WHERE id = $1`, [inFlight.orderId])
    expect(rows[0]).toEqual({ create_started_at: null, provider_error_code: 'RATE_LIMITED' })
  })
})

describe('sweep_stale_payment_order_claims', () => {
  const sweep = async (minutes: number) => {
    const { rows } = await getPool().query(`SELECT public.sweep_stale_payment_order_claims(now() - make_interval(mins => $1)) AS result`, [minutes])
    return rows[0]!.result as { marked_unknown: number; released: number }
  }

  it('marks a create that never got its answer outcome unknown, and releases a claim whose create never started', async () => {
    const ctx = await seedPayable()
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const invoiceId = i === 0 ? ctx.invoiceId : await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })
      const order = await createOneOrder({ ...ctx, invoiceId })
      await setStatus(order.id, 'approved')
      ids.push(order.id)
    }
    await getPool().query(`SELECT public.claim_payment_orders_for_signing($1, $2::uuid[], 'open_payments', $3)`, [ctx.companyId, ids, ctx.userId])
    const [died, neverStarted, running] = ids as [string, string, string]
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = now() - interval '20 minutes' WHERE id = $1`, [died])
    await getPool().query(`UPDATE public.payment_orders SET submitted_at = now() - interval '20 minutes' WHERE id = $1`, [neverStarted])
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = now() WHERE id = $1`, [running])

    const result = await sweep(15)

    expect(result.marked_unknown).toBeGreaterThanOrEqual(1)
    expect(result.released).toBeGreaterThanOrEqual(1)
    const { rows } = await getPool().query(
      `SELECT id, status, create_started_at IS NOT NULL AS in_flight, outcome_unknown_at IS NOT NULL AS unknown, provider_error_code
         FROM public.payment_orders WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.in_flight, r.unknown, r.provider_error_code]]))).toEqual({
      [died]: ['submitted', false, true, 'CREATE_NOT_FINISHED'],
      [neverStarted]: ['approved', false, false, null],
      [running]: ['submitted', true, false, null],
    })
    expect((await eventsOf(died)).find((e) => e.event_type === 'outcome_unknown')?.detail).toEqual({ code: 'CREATE_NOT_FINISHED', source: 'status_sync' })
    expect((await eventsOf(neverStarted)).find((e) => e.event_type === 'released')?.detail).toEqual({ reason: 'CREATE_NEVER_STARTED' })
  })

  it('ends a signing left without any order, and never sweeps closer than ten minutes back', async () => {
    const ctx = await claimedOrder(null)
    await getPool().query(`UPDATE public.payment_orders SET submitted_at = now() - interval '20 minutes' WHERE id = $1`, [ctx.orderId])
    await sweep(15)
    const { rows } = await getPool().query(`SELECT status FROM public.payment_order_batches WHERE id = $1`, [ctx.batchId])
    expect(rows[0].status).toBe('failed')

    await expect(sweep(1)).rejects.toThrow(/at least 10 minutes back/)
  })
})

describe('resolve_payment_order', () => {
  async function resolve(
    ctx: { companyId: string; orderId: string; userId: string },
    resolution: string,
    options: { bankAnswer?: string; paymentId?: string } = {},
  ) {
    const { rows } = await getPool().query(
      `SELECT public.resolve_payment_order($1, $2, $3, $4, $5, $6) AS result`,
      [ctx.companyId, ctx.orderId, resolution, ctx.userId, options.bankAnswer ?? null, options.paymentId ?? null],
    )
    return rows[0]!.result as { ok: boolean; status?: string; code?: string }
  }

  async function paymentRow(ctx: { companyId: string; userId: string }, invoiceId: string, amount: number) {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments (id, supplier_invoice_id, payment_date, amount, currency, company_id, user_id)
       VALUES ($1, $2, '2026-10-20', $3, 'SEK', $4, $5)`,
      [id, invoiceId, amount, ctx.companyId, ctx.userId],
    )
    return id
  }

  it('lets a person cancel an order whose bank outcome is unknown, never one whose create may still answer', async () => {
    const ctx = await claimedOrder(null)
    await getPool().query(`UPDATE public.payment_orders SET create_started_at = now() WHERE id = $1`, [ctx.orderId])
    expect(await resolve(ctx, 'not_at_bank')).toMatchObject({ ok: false, code: 'not_resolvable' })

    await getPool().query(`UPDATE public.payment_orders SET create_started_at = NULL, outcome_unknown_at = now() WHERE id = $1`, [ctx.orderId])
    expect(await resolve(ctx, 'not_at_bank')).toEqual({ ok: true, status: 'cancelled' })

    const { rows } = await getPool().query(`SELECT status, cancelled_by, outcome_unknown_at FROM public.payment_orders WHERE id = $1`, [ctx.orderId])
    expect(rows[0]).toEqual({ status: 'cancelled', cancelled_by: ctx.userId, outcome_unknown_at: null })
    const { rows: events } = await getPool().query(
      `SELECT actor_user_id, detail FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'cancelled'`,
      [ctx.orderId],
    )
    expect(events).toEqual([{ actor_user_id: ctx.userId, detail: { resolution: 'not_at_bank', by: 'person', bank_answer: 'outcome_unknown' } }])
  })

  it('cancels a stranded payment only when the bank does not know it or cannot be asked', async () => {
    const ctx = await claimedOrder('op-pay-s1')
    await setStatus(ctx.orderId, 'accepted')
    expect(await resolve(ctx, 'not_at_bank')).toMatchObject({ ok: false, code: 'not_resolvable' })
    expect(await resolve(ctx, 'not_at_bank', { bankAnswer: 'still_there' })).toMatchObject({ ok: false, code: 'not_resolvable' })
    expect(await resolve(ctx, 'not_at_bank', { bankAnswer: 'no_provider' })).toEqual({ ok: true, status: 'cancelled' })
    const { rows } = await getPool().query(`SELECT status, provider_payment_id FROM public.payment_orders WHERE id = $1`, [ctx.orderId])
    expect(rows[0]).toEqual({ status: 'cancelled', provider_payment_id: 'op-pay-s1' })
  })

  it('settles an order a person confirms paid against the payment row on its invoice', async () => {
    const ctx = await claimedOrder(null)
    await getPool().query(`UPDATE public.payment_orders SET outcome_unknown_at = now() WHERE id = $1`, [ctx.orderId])
    const otherInvoice = await insertSupplierInvoice({ companyId: ctx.companyId, userId: ctx.userId, supplierId: ctx.supplierId })

    expect(await resolve(ctx, 'paid', { paymentId: await paymentRow(ctx, otherInvoice, 737.5) })).toMatchObject({ ok: false, code: 'payment_not_found' })
    expect(await resolve(ctx, 'paid', { paymentId: await paymentRow(ctx, ctx.invoiceId, 500) })).toMatchObject({ ok: false, code: 'payment_mismatch' })
    const paid = await paymentRow(ctx, ctx.invoiceId, 737.5)
    expect(await resolve(ctx, 'paid', { paymentId: paid })).toEqual({ ok: true, status: 'executed' })

    const { rows } = await getPool().query(
      `SELECT status, supplier_invoice_payment_id, outcome_unknown_at, matched_at IS NOT NULL AS matched FROM public.payment_orders WHERE id = $1`,
      [ctx.orderId],
    )
    expect(rows[0]).toEqual({ status: 'executed', supplier_invoice_payment_id: paid, outcome_unknown_at: null, matched: true })
    expect((await eventsOf(ctx.orderId)).find((e) => e.event_type === 'matched')?.detail).toMatchObject({ by: 'person', resolution: 'paid' })
  })

  it('is for a member who may write, through the server only', async () => {
    const ctx = await claimedOrder(null)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })
    await expect(resolve({ ...ctx, userId: viewer }, 'not_at_bank')).rejects.toThrow(/no write role/)

    const { rows } = await getPool().query(
      `SELECT r.rolname, p.proname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can
         FROM pg_proc p CROSS JOIN pg_roles r
        WHERE p.proname IN ('release_payment_order', 'sweep_stale_payment_order_claims', 'resolve_payment_order')
          AND p.pronamespace = 'public'::regnamespace
          AND r.rolname IN ('anon', 'authenticated', 'service_role')`,
    )
    for (const row of rows) expect([row.rolname, row.proname, row.can]).toEqual([row.rolname, row.proname, row.rolname === 'service_role'])
  })
})

describe('what is kept: events, orders that reached a bank, the audit log', () => {
  it('keeps events append-only: no update, no delete, no truncate', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await expect(
      getPool().query(`UPDATE public.payment_order_events SET event_type = 'error' WHERE payment_order_id = $1`, [order.id]),
    ).rejects.toThrow(/append-only/)
    await expect(
      getPool().query(`DELETE FROM public.payment_order_events WHERE payment_order_id = $1`, [order.id]),
    ).rejects.toThrow(/append-only/)
    await expect(getPool().query(`TRUNCATE public.payment_order_events`)).rejects.toThrow(/cannot be truncated/)
    await expect(getPool().query(`TRUNCATE public.payment_orders CASCADE`)).rejects.toThrow(/cannot be truncated/)
  })

  it('deletes an order that never left the app together with its events, and keeps one that was sent to a bank', async () => {
    const ctx = await seedPayable()
    const draft = await createOneOrder(ctx)
    await getPool().query(`DELETE FROM public.payment_orders WHERE id = $1`, [draft.id])
    const gone = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_order_events WHERE payment_order_id = $1`, [draft.id])
    expect(gone.rows[0].n).toBe(0)

    const sent = await createOneOrder(ctx)
    await setStatus(sent.id, 'approved')
    await setStatus(sent.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-kept', submitted_at = now()`)
    await expect(getPool().query(`DELETE FROM public.payment_orders WHERE id = $1`, [sent.id])).rejects.toThrow(/sent to a bank is kept/)

    // A sanctioned delete may still remove it.
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(`DELETE FROM public.payment_orders WHERE id = $1`, [sent.id])
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('does not write an audit row for a poll that only refreshed when the bank was asked', async () => {
    const ctx = await seedPayable()
    const order = await createOneOrder(ctx)
    await setStatus(order.id, 'approved')
    await setStatus(order.id, 'submitted', `, provider = 'open_payments', provider_payment_id = 'op-pay-poll', provider_status = 'RCVD'`)
    const auditRows = async () => {
      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM public.audit_log WHERE table_name = 'payment_orders' AND record_id = $1`,
        [order.id],
      )
      return rows[0].n as number
    }
    const before = await auditRows()

    // Scenario F: four polls, nothing changed but the time the bank was asked.
    for (let i = 0; i < 4; i += 1) {
      await getPool().query(`UPDATE public.payment_orders SET provider_status = 'RCVD', provider_status_at = now() WHERE id = $1`, [order.id])
    }
    expect(await auditRows()).toBe(before)

    await getPool().query(`UPDATE public.payment_orders SET provider_status = 'PATC', provider_status_at = now() WHERE id = $1`, [order.id])
    expect(await auditRows()).toBe(before + 1)
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
