import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCashAccount, insertCompanyMember, seedCompany } from './fixtures'

// pg-real coverage for 20261016180000_payment_orders_skattekonto.sql: the
// widened purpose and payee source, the CHECK that pins a skattekonto order to
// Skatteverket's bankgiro and an OCR number, the one open skattekonto order per
// company and execution day (20261027051717: a same-day addition is added to
// the order nobody signed), create_skattekonto_payment_order (its payee set by the function,
// the 'created' event, idempotent replay and its mismatch, the payload
// refusals, the write-role, sandbox and EXECUTE guards), the claim accepting a
// tax order unchanged, and release_payment_order (directly and through the
// stale-claim sweep) sending one back to approved instead of cancelling it as
// invoice_missing.

const DEBTOR = {
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
  name: 'Företagskonto',
  currency: 'SEK',
  bank_name: 'SEB',
}

const OCR = '1655446688087'

type CreateResult = { ok: boolean; code?: string; details?: unknown; order?: Record<string, unknown> }

async function seedTaxPayer() {
  const ctx = await seedCompany()
  const cashAccountId = await insertCashAccount({
    companyId: ctx.companyId,
    ledgerAccount: '1930',
    iban: DEBTOR.iban,
    source: 'enable_banking',
  })
  return { ...ctx, cashAccountId }
}

// Service-role style call: no JWT claims on the superuser pool, so the RPC
// takes p_user_id as the actor (the route authenticated the person in code).
async function createTaxOrder(
  ctx: { companyId: string; userId: string; cashAccountId: string },
  overrides: { amount?: number; reference?: string | null; idempotencyKey?: string | null; userId?: string; date?: string } = {},
): Promise<CreateResult> {
  const { rows } = await getPool().query<{ result: CreateResult }>(
    `SELECT public.create_skattekonto_payment_order($1, $2, $3::jsonb, $4, $5::date, $6, $7, $8) AS result`,
    [
      ctx.companyId,
      ctx.cashAccountId,
      JSON.stringify(DEBTOR),
      overrides.amount ?? 15000.5,
      overrides.date ?? '2026-11-11',
      overrides.reference === undefined ? OCR : overrides.reference,
      overrides.idempotencyKey === undefined ? randomUUID() : overrides.idempotencyKey,
      overrides.userId ?? ctx.userId,
    ],
  )
  return rows[0]!.result
}

async function createdTaxOrder(ctx: { companyId: string; userId: string; cashAccountId: string }) {
  const result = await createTaxOrder(ctx)
  expect(result.ok).toBe(true)
  return result.order! as { id: string; status: string; end_to_end_id: string }
}

async function setStatus(orderId: string, status: string, extra = '') {
  await getPool().query(`UPDATE public.payment_orders SET status = $2 ${extra} WHERE id = $1`, [orderId, status])
}

async function claim(companyId: string, userId: string, orderIds: string[]) {
  const { rows } = await getPool().query<{ result: { ok: boolean; code?: string; batch?: Record<string, unknown>; orders?: Array<Record<string, unknown>> } }>(
    `SELECT public.claim_payment_orders_for_signing($1, $2::uuid[], 'open_payments', $3) AS result`,
    [companyId, orderIds, userId],
  )
  return rows[0]!.result
}

/** A supplier invoice order in the same company, through create_payment_orders. */
async function supplierOrder(ctx: { companyId: string; userId: string; cashAccountId: string }, idempotencyKey: string) {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro) VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [supplierId, ctx.userId, ctx.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status, currency)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-09-20', '2026-10-20',
             590, 147.5, 737.5, 737.5, 'approved', 'SEK')`,
    [invoiceId, ctx.userId, ctx.companyId, supplierId, `CD-${invoiceId.slice(0, 8)}`],
  )
  const { rows } = await getPool().query(
    `SELECT public.create_payment_orders($1, $2::jsonb, $3) AS result`,
    [
      ctx.companyId,
      JSON.stringify([
        {
          supplier_invoice_id: invoiceId,
          amount: 737.5,
          currency: 'SEK',
          requested_execution_date: '2026-10-20',
          cash_account_id: ctx.cashAccountId,
          debtor_snapshot: DEBTOR,
          payee_type: 'bankgiro',
          payee_bankgiro: '50501055',
          payee_name: 'Derome Bygg AB',
          payee_source: 'supplier',
          reference_type: 'ocr',
          reference: '4400112233',
          idempotency_key: idempotencyKey,
        },
      ]),
      ctx.userId,
    ],
  )
  expect(rows[0].result.ok).toBe(true)
  return rows[0].result.orders[0] as { id: string }
}

describe('create_skattekonto_payment_order', () => {
  it('creates a draft to Skatteverket that the function itself addresses, with a created event', async () => {
    const ctx = await seedTaxPayer()
    const order = await createdTaxOrder(ctx)

    const { rows } = await getPool().query(
      `SELECT purpose, supplier_invoice_id, status, amount, currency, requested_execution_date::text AS date,
              payee_type, payee_bankgiro, payee_name, payee_source, payee_check, reference_type, reference, user_id
         FROM public.payment_orders WHERE id = $1`,
      [order.id],
    )
    expect(rows[0]).toEqual({
      purpose: 'skattekonto',
      supplier_invoice_id: null,
      status: 'draft',
      amount: '15000.50',
      currency: 'SEK',
      date: '2026-11-11',
      payee_type: 'bankgiro',
      payee_bankgiro: '50501055',
      payee_name: 'Skatteverket',
      payee_source: 'skatteverket',
      payee_check: 'known',
      reference_type: 'ocr',
      reference: OCR,
      user_id: ctx.userId,
    })
    expect(order.end_to_end_id).toMatch(/^ACC[0-9a-f]{32}$/)
    const events = await getPool().query(
      `SELECT event_type, to_status, actor_user_id FROM public.payment_order_events WHERE payment_order_id = $1`,
      [order.id],
    )
    expect(events.rows).toEqual([{ event_type: 'created', to_status: 'draft', actor_user_id: ctx.userId }])
  })

  it('rounds the amount to öre', async () => {
    const ctx = await seedTaxPayer()
    const result = await createTaxOrder(ctx, { amount: 1234.567 })
    expect(Number(result.order!.amount)).toBe(1234.57)
  })

  it('returns the existing order when an idempotency key is replayed, and refuses a key a supplier payment used', async () => {
    const ctx = await seedTaxPayer()
    const first = await createTaxOrder(ctx, { idempotencyKey: 'skv-replay-1' })
    const second = await createTaxOrder(ctx, { idempotencyKey: 'skv-replay-1', amount: 99 })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: true, order: { id: first.order!.id } })
    const count = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_orders WHERE company_id = $1`, [ctx.companyId])
    expect(count.rows[0].n).toBe(1)

    const other = await seedTaxPayer()
    const supplier = await supplierOrder(other, 'shared-key')
    expect(await createTaxOrder(other, { idempotencyKey: 'shared-key' })).toMatchObject({
      ok: false,
      code: 'idempotency_mismatch',
      details: { payment_order_id: supplier.id },
    })
  })

  it('refuses an amount of zero or less, a reference that is not an OCR number and a missing key', async () => {
    const ctx = await seedTaxPayer()
    expect(await createTaxOrder(ctx, { amount: 0 })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createTaxOrder(ctx, { amount: -10 })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createTaxOrder(ctx, { amount: 0.004 })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createTaxOrder(ctx, { reference: '1655-9547' })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createTaxOrder(ctx, { reference: null })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(await createTaxOrder(ctx, { idempotencyKey: null })).toMatchObject({ ok: false, code: 'invalid_payload' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_orders WHERE company_id = $1`, [ctx.companyId])
    expect(rows[0].n).toBe(0)
  })

  it('refuses a sandbox company, even when called directly', async () => {
    const ctx = await seedTaxPayer()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, true)
       ON CONFLICT (company_id) DO UPDATE SET is_sandbox = true`,
      [ctx.userId, ctx.companyId],
    )
    expect(await createTaxOrder(ctx)).toMatchObject({ ok: false, code: 'sandbox' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.payment_orders WHERE company_id = $1`, [ctx.companyId])
    expect(rows[0].n).toBe(0)
  })

  it('refuses a viewer, a non-member and any browser session; EXECUTE is the service role\'s alone', async () => {
    const ctx = await seedTaxPayer()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })
    await expect(createTaxOrder(ctx, { userId: viewer })).rejects.toThrow(/no write role/)
    const stranger = await insertAuthUser()
    await expect(createTaxOrder(ctx, { userId: stranger })).rejects.toThrow(/no write role/)

    await expect(
      withUserContext(ctx.userId, (client) =>
        client.query(
          `SELECT public.create_skattekonto_payment_order($1, $2, '{}'::jsonb, 100, '2026-11-11'::date, $3, 'k')`,
          [ctx.companyId, ctx.cashAccountId, OCR],
        ),
      ),
    ).rejects.toThrow(/permission denied for function/)

    const { rows } = await getPool().query(
      `SELECT r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can
         FROM pg_proc p CROSS JOIN pg_roles r
        WHERE p.proname = 'create_skattekonto_payment_order'
          AND p.pronamespace = 'public'::regnamespace
          AND r.rolname IN ('anon', 'authenticated', 'service_role')`,
    )
    expect(rows).toHaveLength(3)
    for (const row of rows) expect([row.rolname, row.can]).toEqual([row.rolname, row.rolname === 'service_role'])
  })
})

describe('one open skattekonto order per company and execution day (20261027051717, crm#1485)', () => {
  it('adds to the day\'s draft, and to an approved order sent back to draft, keeping what was added', async () => {
    const ctx = await seedTaxPayer()
    const first = await createdTaxOrder(ctx)
    const key = randomUUID()
    const added = await createTaxOrder(ctx, { amount: 3433, idempotencyKey: key })
    expect(added).toMatchObject({
      ok: true,
      order: { id: first.id, status: 'draft', amount: 18433.5 },
      merged: { previous_amount: 15000.5, added_amount: 3433 },
    })
    // A replay of the same key never adds twice.
    expect(await createTaxOrder(ctx, { amount: 3433, idempotencyKey: key })).toMatchObject({ ok: true, order: { id: first.id, amount: 18433.5 } })

    await setStatus(first.id, 'approved', `, approved_by = '${ctx.userId}', approved_at = now()`)
    expect(await createTaxOrder(ctx, { amount: 100 })).toMatchObject({ ok: true, order: { id: first.id, status: 'draft', amount: 18533.5, approved_at: null } })

    const { rows: events } = await getPool().query<{ event_type: string; detail: Record<string, unknown> | null }>(
      `SELECT event_type, detail FROM public.payment_order_events WHERE payment_order_id = $1 ORDER BY occurred_at, event_type`,
      [first.id],
    )
    expect(events.filter((e) => e.event_type === 'edited')).toHaveLength(2)
    expect(events.filter((e) => e.event_type === 'unapproved')).toHaveLength(1)
    expect(events.find((e) => e.event_type === 'edited')?.detail).toMatchObject({ reason: 'amount_added', idempotency_key: key })
  })

  it('refuses the day while its order is claimed for signing or at the bank, and lets another day have its own', async () => {
    const ctx = await seedTaxPayer()
    const first = await createdTaxOrder(ctx)
    await setStatus(first.id, 'approved')
    await setStatus(first.id, 'submitted', `, provider = 'open_payments'`)
    expect(await createTaxOrder(ctx)).toMatchObject({
      ok: false,
      code: 'already_in_payment',
      details: { payment_order_id: first.id, status: 'submitted' },
    })
    await setStatus(first.id, 'accepted')
    expect(await createTaxOrder(ctx)).toMatchObject({ ok: false, code: 'already_in_payment' })

    const other = await createTaxOrder(ctx, { amount: 3433, date: '2026-11-10' })
    expect(other).toMatchObject({ ok: true, order: { status: 'draft', amount: 3433, requested_execution_date: '2026-11-10' } })
    expect((other.order as { id: string }).id).not.toBe(first.id)

    // The index is the last word on a writer that skipped the function.
    await expect(
      getPool().query(
        `INSERT INTO public.payment_orders
           (company_id, user_id, purpose, amount, requested_execution_date, cash_account_id, debtor_snapshot,
            payee_type, payee_bankgiro, payee_name, payee_source, reference_type, reference, idempotency_key)
         VALUES ($1, $2, 'skattekonto', 10, '2026-11-11', $3, $4::jsonb,
                 'bankgiro', '50501055', 'Skatteverket', 'skatteverket', 'ocr', $5, $6)`,
        [ctx.companyId, ctx.userId, ctx.cashAccountId, JSON.stringify(DEBTOR), OCR, randomUUID()],
      ),
    ).rejects.toThrow(/uq_payment_orders_open_skattekonto_per_date/)
  })

  it('allows the next order once the open one is executed or cancelled, and never counts another company', async () => {
    const ctx = await seedTaxPayer()
    const first = await createdTaxOrder(ctx)
    await setStatus(first.id, 'approved')
    await setStatus(first.id, 'submitted', `, provider = 'open_payments'`)
    await setStatus(first.id, 'executed', `, executed_at = now()`)
    const second = await createdTaxOrder(ctx)
    await setStatus(second.id, 'cancelled', `, cancelled_at = now()`)
    await createdTaxOrder(ctx)

    const other = await seedTaxPayer()
    await createdTaxOrder(other)
  })

  it('lets a supplier payment and a skattekonto payment be open side by side', async () => {
    const ctx = await seedTaxPayer()
    await supplierOrder(ctx, randomUUID())
    await createdTaxOrder(ctx)
    await supplierOrder(ctx, randomUUID())
  })
})

describe('what a skattekonto order is', () => {
  it('keeps a skattekonto draft on Skatteverket\'s bankgiro, an OCR number of digits and SEK', async () => {
    const ctx = await seedTaxPayer()
    const order = await createdTaxOrder(ctx)
    const update = (set: string) => getPool().query(`UPDATE public.payment_orders SET ${set} WHERE id = $1`, [order.id])

    await expect(update(`payee_bankgiro = '54020102'`)).rejects.toThrow(/payment_orders_skattekonto_instruction/)
    await expect(update(`reference = '16559547002A'`)).rejects.toThrow(/payment_orders_skattekonto_instruction/)
    await expect(update(`reference_type = 'message'`)).rejects.toThrow(/payment_orders_skattekonto_instruction/)
    await expect(update(`currency = 'EUR'`)).rejects.toThrow(/payment_orders_skattekonto_instruction/)
    await expect(update(`payee_source = 'supplier'`)).rejects.toThrow(/payment_orders_skattekonto_instruction/)
    await expect(
      update(`payee_type = 'plusgiro', payee_plusgiro = '1234566', payee_bankgiro = NULL`),
    ).rejects.toThrow(/payment_orders_skattekonto_instruction/)
  })

  it('never gives a skattekonto order a supplier invoice, nor a supplier payment the payee source skatteverket', async () => {
    const ctx = await seedTaxPayer()
    const supplier = await supplierOrder(ctx, randomUUID())
    await expect(
      getPool().query(`UPDATE public.payment_orders SET payee_source = 'skatteverket' WHERE id = $1`, [supplier.id]),
    ).rejects.toThrow(/payment_orders_skattekonto_instruction/)

    const { rows } = await getPool().query(`SELECT supplier_invoice_id FROM public.payment_orders WHERE id = $1`, [supplier.id])
    await expect(
      getPool().query(
        `INSERT INTO public.payment_orders
           (company_id, user_id, purpose, supplier_invoice_id, amount, requested_execution_date, cash_account_id, debtor_snapshot,
            payee_type, payee_bankgiro, payee_name, payee_source, reference_type, reference, idempotency_key)
         VALUES ($1, $2, 'skattekonto', $3, 10, '2026-11-11', $4, $5::jsonb,
                 'bankgiro', '50501055', 'Skatteverket', 'skatteverket', 'ocr', $6, $7)`,
        [ctx.companyId, ctx.userId, rows[0].supplier_invoice_id, ctx.cashAccountId, JSON.stringify(DEBTOR), OCR, randomUUID()],
      ),
    ).rejects.toThrow(/payment_orders_skattekonto_instruction/)
  })

  it('knows no purpose and no payee source beyond the ones a migration added', async () => {
    const ctx = await seedTaxPayer()
    const insert = (purpose: string, source: string) =>
      getPool().query(
        `INSERT INTO public.payment_orders
           (company_id, user_id, purpose, amount, requested_execution_date, cash_account_id, debtor_snapshot,
            payee_type, payee_bankgiro, payee_name, payee_source, reference_type, reference, idempotency_key)
         VALUES ($1, $2, $3, 10, '2026-11-11', $4, $5::jsonb,
                 'bankgiro', '50501055', 'Skatteverket', $6, 'ocr', $7, $8)`,
        [ctx.companyId, ctx.userId, purpose, ctx.cashAccountId, JSON.stringify(DEBTOR), source, OCR, randomUUID()],
      )
    // salary and employee arrived with 20261027100000 (tests/pg/payment-orders-salary.pg.test.ts).
    await expect(insert('refund', 'skatteverket')).rejects.toThrow(/payment_orders_purpose_check/)
    await expect(insert('skattekonto', 'agency')).rejects.toThrow(/payment_orders_payee_source_check/)
  })
})

describe('signing a skattekonto order', () => {
  it('is claimed like a supplier payment: one signing that is the payment itself', async () => {
    const ctx = await seedTaxPayer()
    const order = await createdTaxOrder(ctx)
    await setStatus(order.id, 'approved')

    const result = await claim(ctx.companyId, ctx.userId, [order.id])

    expect(result.ok).toBe(true)
    expect(result.batch).toMatchObject({ signing_target: 'payment', order_count: 1, status: 'created' })
    expect(Number(result.batch!.total_amount)).toBe(15000.5)
    expect(result.orders![0]).toMatchObject({ id: order.id, status: 'submitted', provider: 'open_payments', batch_id: result.batch!.id })
  })

  it('goes back to approved when the bank confirmed the cancel of its payment, never cancelled as invoice_missing', async () => {
    const ctx = await seedTaxPayer()
    const order = await createdTaxOrder(ctx)
    await setStatus(order.id, 'approved')
    const claimed = await claim(ctx.companyId, ctx.userId, [order.id])
    const batchId = claimed.batch!.id as string
    await getPool().query(`UPDATE public.payment_orders SET provider_payment_id = 'skv-pay-1', status = 'awaiting_signature' WHERE id = $1`, [order.id])

    const { rows } = await getPool().query(
      `SELECT public.release_payment_order($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
      [ctx.companyId, order.id, batchId, 'skv-pay-1', 'CANC', 'SIGNING_STOPPED', null, ctx.userId],
    )
    expect(rows[0].result).toEqual({ ok: true, status: 'approved' })

    const after = await getPool().query(`SELECT status, batch_id, provider_payment_id FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(after.rows[0]).toEqual({ status: 'approved', batch_id: null, provider_payment_id: null })
    const events = await getPool().query(
      `SELECT event_type FROM public.payment_order_events WHERE payment_order_id = $1 ORDER BY occurred_at, event_type`,
      [order.id],
    )
    expect(events.rows.map((e) => e.event_type)).toEqual(expect.arrayContaining(['provider_cancelled', 'released']))
    expect(events.rows.map((e) => e.event_type)).not.toContain('cancelled')

    // Approved again, it can be signed again.
    expect(await claim(ctx.companyId, ctx.userId, [order.id])).toMatchObject({ ok: true })
  })

  it('is released to approved by the stale-claim sweep when its create never started', async () => {
    const ctx = await seedTaxPayer()
    const order = await createdTaxOrder(ctx)
    await setStatus(order.id, 'approved')
    await claim(ctx.companyId, ctx.userId, [order.id])
    await getPool().query(`UPDATE public.payment_orders SET submitted_at = now() - interval '1 hour' WHERE id = $1`, [order.id])

    const { rows } = await getPool().query(`SELECT public.sweep_stale_payment_order_claims(now() - interval '15 minutes') AS result`)
    expect(rows[0].result.released).toBeGreaterThanOrEqual(1)

    const after = await getPool().query(`SELECT status FROM public.payment_orders WHERE id = $1`, [order.id])
    expect(after.rows[0].status).toBe('approved')
  })
})
