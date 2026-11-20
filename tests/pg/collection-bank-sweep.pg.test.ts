import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertTransaction, seedCompany } from './fixtures'

/**
 * The payment-candidate sweep and the reconcile of cases under collection
 * (20261012030500_collection_bank_sweep_and_reconcile.sql): the sweep hits
 * table (one row per case and bank row, its shape, RLS and grants), the Att
 * göra reasons possible_payment and outstanding_mismatch,
 * reconcile_collection_forwards (missing rows created, removed payments
 * reverted, unsent ones skipped, the reach of a case), the disconnect
 * obligation of a closed case with a revert to send, and the sandbox
 * teardown.
 */

interface Seed {
  companyId: string
  userId: string
}

async function insertConnection(seed: Seed, route: 'connect' | 'fake' = 'connect'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_connections
       (company_id, user_id, route, provider_ref, display_name, state,
        catalogue_terms_version, consented_by, consented_at, activated_at, ladder_mode)
     VALUES ($1, $2, $3, 'acme-inkasso', 'Acme Inkasso', 'active', 'v1', $2, now(), now(), 'off')
     RETURNING id`,
    [seed.companyId, seed.userId, route],
  )
  return rows[0]!.id
}

async function insertInvoice(seed: Seed, cols: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, seed.userId, seed.companyId],
  )
  const status = (cols.status as string | undefined) ?? 'sent'
  const base: Record<string, unknown> = {
    id,
    user_id: seed.userId,
    company_id: seed.companyId,
    customer_id: customerId,
    invoice_date: '2026-06-01',
    due_date: '2026-06-30',
    currency: 'SEK',
    vat_treatment: 'standard_25',
    vat_rate: 25,
    subtotal: 800,
    vat_amount: 200,
    total: 1000,
    status,
    invoice_number: status === 'draft' ? null : `T-${id.slice(0, 8)}`,
    ...cols,
  }
  const keys = Object.keys(base)
  await getPool().query(
    `INSERT INTO public.invoices (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    keys.map((k) => base[k]),
  )
  return id
}

async function insertCase(params: { companyId: string; invoiceId: string; connectionId: string; status?: 'preparing' | 'registered' }): Promise<string> {
  const status = params.status ?? 'registered'
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_cases
       (company_id, invoice_id, connection_id, origin, start_step, submission_status, provider_case_ref,
        stage, claim_amount, outstanding_principal, bank_check)
     VALUES ($1, $2, $3, 'handover', 'reminder', $4, $5, 'reminder', 1000, 1000, '{"outcome":"pass"}'::jsonb)
     RETURNING id`,
    [params.companyId, params.invoiceId, params.connectionId, status, status === 'registered' ? `ref-${randomUUID()}` : null],
  )
  return rows[0]!.id
}

async function register(caseId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.collection_cases SET submission_status = 'registered', provider_case_ref = $2 WHERE id = $1`,
    [caseId, `ref-${randomUUID()}`],
  )
}

async function closeAsPaid(caseId: string, daysAgo: number): Promise<void> {
  await getPool().query(
    `UPDATE public.collection_cases
        SET is_open = false, stage = 'closed_paid', close_reason = 'paid', closed_at = now() - make_interval(days => $2)
      WHERE id = $1`,
    [caseId, daysAgo],
  )
}

async function insertPayment(seed: Seed, invoiceId: string, amount: number, source: string | null = 'bank'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, source)
     VALUES ($1, $2, $3, '2026-07-02', $4, 'SEK', $5) RETURNING id`,
    [seed.userId, seed.companyId, invoiceId, amount, source],
  )
  return rows[0]!.id
}

async function forwards(caseId: string) {
  const { rows } = await getPool().query<{ kind: string; status: string; amount: string; invoice_payment_id: string | null; credit_invoice_id: string | null; last_error: string | null }>(
    `SELECT kind, status, amount::text, invoice_payment_id, credit_invoice_id, last_error
       FROM public.collection_payment_forwards WHERE case_id = $1 ORDER BY created_at, id`,
    [caseId],
  )
  return rows
}

async function reconcile(companyId: string | null) {
  const { rows } = await getPool().query<{ r: Record<string, number> }>(`SELECT public.reconcile_collection_forwards($1) AS r`, [companyId])
  return rows[0]!.r
}

async function caseWorld(options: { status?: 'preparing' | 'registered'; route?: 'connect' | 'fake' } = {}) {
  const seed = await seedCompany()
  const connectionId = await insertConnection(seed, options.route)
  const invoiceId = await insertInvoice(seed)
  const caseId = await insertCase({ companyId: seed.companyId, invoiceId, connectionId, status: options.status })
  return { ...seed, connectionId, invoiceId, caseId }
}

async function insertHit(w: { companyId: string; userId: string; caseId: string }, cols: Record<string, unknown> = {}) {
  const transactionId = (cols.transaction_id as string | undefined) ?? (await insertTransaction({ companyId: w.companyId, userId: w.userId, amount: 1000, date: '2026-07-05' }))
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_sweep_hits (company_id, case_id, transaction_id, reason, amount, transaction_date, status, pause_state)
     VALUES ($1, $2, $3, $4, $5, '2026-07-05', $6, $7) RETURNING id`,
    [w.companyId, w.caseId, transactionId, cols.reason ?? 'reference', cols.amount ?? 1000, cols.status ?? 'open', cols.pause_state ?? 'paused'],
  )
  return { id: rows[0]!.id, transactionId }
}

async function reasons(companyId: string, caseId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ reason: string }>(
    `SELECT reason FROM public.collection_attention_case_ids($1) WHERE case_id = $2 ORDER BY reason`,
    [companyId, caseId],
  )
  return rows.map((r) => r.reason)
}

describe('collection_sweep_hits (pg)', () => {
  it('records a bank row once per case, keeps its shape and its company', async () => {
    const w = await caseWorld()
    const { transactionId, id } = await insertHit(w)
    await expect(insertHit(w, { transaction_id: transactionId })).rejects.toThrow(/collection_sweep_hits_once/)
    await expect(
      getPool().query(`UPDATE public.collection_sweep_hits SET status = 'dismissed' WHERE id = $1`, [id]),
    ).rejects.toThrow(/collection_sweep_hits_resolved_shape/)
    await getPool().query(`UPDATE public.collection_sweep_hits SET status = 'dismissed', resolved_at = now(), resolved_by = $2 WHERE id = $1`, [
      id,
      w.userId,
    ])
    await expect(
      getPool().query(`UPDATE public.collection_sweep_hits SET transaction_id = $2 WHERE id = $1`, [id, randomUUID()]),
    ).rejects.toThrow(/keeps its company, case and bank row/)

    const other = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.collection_sweep_hits (company_id, case_id, transaction_id, reason, amount, transaction_date)
         VALUES ($1, $2, $3, 'name', 10, '2026-07-05')`,
        [other.companyId, w.caseId, randomUUID()],
      ),
    ).rejects.toThrow(/belongs to its case's company/)
    await expect(insertHit(w, { reason: 'guess' })).rejects.toThrow(/collection_sweep_hits_reason_check/)
  })

  it("members read their own company's hits only and write none; grants", async () => {
    const w = await caseWorld()
    await insertHit(w)
    const outsider = await insertAuthUser()
    const otherCompany = await seedCompany()
    await insertCompanyMember({ companyId: otherCompany.companyId, userId: outsider, role: 'owner' })

    await withUserContext(w.userId, async (client) => {
      expect((await client.query(`SELECT 1 FROM public.collection_sweep_hits WHERE case_id = $1`, [w.caseId])).rows).toHaveLength(1)
      await expect(
        client.query(
          `INSERT INTO public.collection_sweep_hits (company_id, case_id, transaction_id, reason, amount, transaction_date)
           VALUES ($1, $2, $3, 'name', 10, '2026-07-05')`,
          [w.companyId, w.caseId, randomUUID()],
        ),
      ).rejects.toThrow(/permission denied|row-level security/)
    })
    await withUserContext(outsider, async (client) => {
      expect((await client.query(`SELECT 1 FROM public.collection_sweep_hits WHERE case_id = $1`, [w.caseId])).rows).toHaveLength(0)
    })
    const { rows } = await getPool().query<Record<string, boolean>>(
      `SELECT has_table_privilege('anon', 'public.collection_sweep_hits', 'SELECT') AS anon_select,
              has_table_privilege('authenticated', 'public.collection_sweep_hits', 'UPDATE') AS auth_update,
              has_table_privilege('service_role', 'public.collection_sweep_hits', 'INSERT') AS service_insert,
              has_function_privilege('authenticated', 'public.reconcile_collection_forwards(uuid)', 'EXECUTE') AS auth_reconcile,
              has_function_privilege('service_role', 'public.reconcile_collection_forwards(uuid)', 'EXECUTE') AS service_reconcile`,
    )
    expect(rows[0]).toEqual({ anon_select: false, auth_update: false, service_insert: true, auth_reconcile: false, service_reconcile: true })
  })
})

describe('Att göra: possible payments and mismatches (pg)', () => {
  it('asks about an unbooked bank row the sweep found, until it is booked', async () => {
    const w = await caseWorld()
    const { transactionId } = await insertHit(w)
    expect(await reasons(w.companyId, w.caseId)).toEqual(['possible_payment'])
    await getPool().query(`UPDATE public.transactions SET invoice_id = $2 WHERE id = $1`, [transactionId, w.invoiceId])
    expect(await reasons(w.companyId, w.caseId)).toEqual([])
  })

  it('keeps a case the sweep paused in Att göra until it is resumed or closes, whatever its hits say', async () => {
    const w = await caseWorld()
    await getPool().query(`UPDATE public.collection_cases SET paused_by_sweep = true, pause_reason = 'possible_payment' WHERE id = $1`, [w.caseId])
    expect(await reasons(w.companyId, w.caseId)).toEqual(['possible_payment'])
    await getPool().query(`UPDATE public.collection_cases SET paused_by_sweep = false, pause_reason = null WHERE id = $1`, [w.caseId])
    expect(await reasons(w.companyId, w.caseId)).toEqual([])
  })

  it('names a provider principal that differs from the books, and a pause over it, on an open case only', async () => {
    const w = await caseWorld()
    await getPool().query(`UPDATE public.collection_cases SET outstanding_mismatch = 250, outstanding_expected = 750 WHERE id = $1`, [w.caseId])
    expect(await reasons(w.companyId, w.caseId)).toEqual(['outstanding_mismatch'])
    await getPool().query(
      `UPDATE public.collection_cases SET outstanding_mismatch = null, paused_by_sweep = true, pause_reason = 'outstanding_mismatch' WHERE id = $1`,
      [w.caseId],
    )
    expect(await reasons(w.companyId, w.caseId)).toEqual(['outstanding_mismatch'])
    await closeAsPaid(w.caseId, 0)
    expect(await reasons(w.companyId, w.caseId)).toEqual([])
  })

  it('shows a member nothing of another company', async () => {
    const w = await caseWorld()
    await insertHit(w)
    const outsider = await insertAuthUser()
    await withUserContext(outsider, async (client) => {
      expect((await client.query(`SELECT 1 FROM public.collection_attention_case_ids($1)`, [w.companyId])).rows).toHaveLength(0)
    })
    await withUserContext(w.userId, async (client) => {
      expect((await client.query(`SELECT reason FROM public.collection_attention_case_ids($1)`, [w.companyId])).rows).toEqual([
        { reason: 'possible_payment' },
      ])
    })
  })
})

describe('reconcile_collection_forwards (pg)', () => {
  it('reports a payment written while the handover was in flight, which no trigger queued', async () => {
    const w = await caseWorld({ status: 'preparing' })
    const raced = await insertPayment(w, w.invoiceId, 300)
    expect(await forwards(w.caseId)).toEqual([])
    await register(w.caseId)
    expect(await reconcile(w.companyId)).toEqual({ created_payments: 1, created_credits: 0, reverted: 0, skipped: 0 })
    expect(await forwards(w.caseId)).toEqual([expect.objectContaining({ kind: 'payment', status: 'pending', amount: '300.00', invoice_payment_id: raced })])
    // Idempotent.
    expect(await reconcile(w.companyId)).toEqual({ created_payments: 0, created_credits: 0, reverted: 0, skipped: 0 })
  })

  it('never reports a payment recorded before the handover read the invoice, nor the provider\'s own collection', async () => {
    const w = await caseWorld({ status: 'preparing' })
    const before = await insertPayment(w, w.invoiceId, 200)
    await getPool().query(`UPDATE public.invoice_payments SET created_at = now() - interval '1 hour' WHERE id = $1`, [before])
    await insertPayment(w, w.invoiceId, 100, 'collections')
    await register(w.caseId)
    expect(await reconcile(w.companyId)).toMatchObject({ created_payments: 0 })
    expect(await forwards(w.caseId)).toEqual([])
  })

  it('queues an issued credit note on an open case, not a draft', async () => {
    const w = await caseWorld({ status: 'preparing' })
    const credit = await insertInvoice(w, { credited_invoice_id: w.invoiceId, total: -200, subtotal: -160, vat_amount: -40, status: 'sent' })
    await insertInvoice(w, { credited_invoice_id: w.invoiceId, total: -50, subtotal: -40, vat_amount: -10, status: 'draft' })
    await register(w.caseId)
    expect(await reconcile(w.companyId)).toMatchObject({ created_credits: 1 })
    expect(await forwards(w.caseId)).toEqual([
      expect.objectContaining({ kind: 'credit_note', status: 'pending', amount: '200.00', credit_invoice_id: credit }),
    ])
  })

  it('reverts a reported payment whose row is gone and skips one never sent', async () => {
    const w = await caseWorld()
    const goneReported = randomUUID()
    const goneUnsent = randomUUID()
    await getPool().query(
      `INSERT INTO public.collection_payment_forwards (company_id, case_id, kind, invoice_payment_id, amount, payment_date, status, forwarded_at, sent_amount)
       VALUES ($1, $2, 'payment', $3, 100, '2026-07-01', 'forwarded', now(), 100),
              ($1, $2, 'payment', $4, 50, '2026-07-01', 'pending', null, null)`,
      [w.companyId, w.caseId, goneReported, goneUnsent],
    )
    expect(await reconcile(null)).toMatchObject({ reverted: 1, skipped: 1 })
    const rows = await forwards(w.caseId)
    expect(rows.find((r) => r.invoice_payment_id === goneReported)).toMatchObject({ status: 'revert_pending' })
    expect(rows.find((r) => r.invoice_payment_id === goneUnsent)).toMatchObject({ status: 'skipped', last_error: 'payment_removed' })
  })

  it('reaches a case closed as paid in the last 90 days (an unmatch and rematch), not an older one, and only the named company', async () => {
    const recent = await caseWorld({ status: 'preparing' })
    await insertPayment(recent, recent.invoiceId, 1000)
    await register(recent.caseId)
    await closeAsPaid(recent.caseId, 10)
    const old = await caseWorld({ status: 'preparing' })
    await insertPayment(old, old.invoiceId, 1000)
    await register(old.caseId)
    await closeAsPaid(old.caseId, 100)

    expect(await reconcile(old.companyId)).toMatchObject({ created_payments: 0 })
    expect(await reconcile(recent.companyId)).toMatchObject({ created_payments: 1 })
    expect(await forwards(recent.caseId)).toHaveLength(1)
    expect(await reconcile(null)).toMatchObject({ created_payments: 0 })
    expect(await forwards(old.caseId)).toEqual([])
  })
})

describe('collection_obligation_counts (pg)', () => {
  it('counts a closed case with a revert still to send', async () => {
    const w = await caseWorld()
    const count = async () =>
      (await getPool().query<{ open_cases: number }>(`SELECT open_cases FROM public.collection_obligation_counts($1)`, [w.companyId])).rows[0]!
        .open_cases
    expect(await count()).toBe(1)
    const paymentId = await insertPayment(w, w.invoiceId, 1000)
    await getPool().query(`UPDATE public.collection_payment_forwards SET status = 'forwarded', forwarded_at = now(), sent_amount = 1000 WHERE invoice_payment_id = $1`, [
      paymentId,
    ])
    await closeAsPaid(w.caseId, 1)
    expect(await count()).toBe(0)
    await getPool().query(`DELETE FROM public.invoice_payments WHERE id = $1`, [paymentId])
    expect(await count()).toBe(1)
  })
})

describe('sandbox teardown (pg)', () => {
  it('removes a sandbox company\'s sweep hits with its cases', async () => {
    const sandbox = await seedCompany()
    await getPool().query(`INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`, [sandbox.userId, sandbox.companyId])
    const connectionId = await insertConnection(sandbox, 'fake')
    const invoiceId = await insertInvoice(sandbox)
    const caseId = await insertCase({ companyId: sandbox.companyId, invoiceId, connectionId })
    const hit = await insertHit({ ...sandbox, caseId })
    await getPool().query(`UPDATE public.collection_sweep_hits SET status = 'dismissed', resolved_at = now(), resolved_by = $2 WHERE id = $1`, [
      hit.id,
      sandbox.userId,
    ])
    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])
    const left = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM public.collection_sweep_hits WHERE company_id = $1`, [sandbox.companyId])
    expect(Number(left.rows[0]!.n)).toBe(0)
  })
})
