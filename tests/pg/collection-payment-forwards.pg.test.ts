import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Payment provenance and forwarding to the collections provider
 * (20261012030300_invoice_payment_provenance.sql,
 *  20261012030400_collection_payment_forwards.sql): every write path that
 * records or removes a payment, or issues a credit note, on an invoice under
 * collection fills the outbox; the provider's own collections never do; the
 * drain's claim and finish keep one sender per row and per case; the seed at
 * registration; a collected payment cannot be removed; Att göra; grants and
 * the sandbox teardown.
 */

type Db = Pick<PoolClient, 'query'>

interface Seed {
  companyId: string
  userId: string
  fiscalPeriodId: string
}

async function insertConnection(seed: Pick<Seed, 'companyId' | 'userId'>, route: 'connect' | 'fake' = 'connect'): Promise<string> {
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

async function insertCustomer(seed: Pick<Seed, 'companyId' | 'userId'>): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [id, seed.userId, seed.companyId],
  )
  return id
}

async function insertInvoice(seed: Pick<Seed, 'companyId' | 'userId'>, cols: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const customerId = (cols.customer_id as string | undefined) ?? (await insertCustomer(seed))
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

async function insertCase(params: {
  companyId: string
  invoiceId: string
  connectionId: string
  status?: 'preparing' | 'submitted' | 'registered'
  principal?: number | null
}): Promise<string> {
  const status = params.status ?? 'registered'
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_cases
       (company_id, invoice_id, connection_id, origin, start_step, submission_status, provider_case_ref,
        stage, claim_amount, outstanding_principal, bank_check)
     VALUES ($1, $2, $3, 'handover', 'reminder', $4, $5, 'reminder', 1000, $6, '{"outcome":"pass"}'::jsonb)
     RETURNING id`,
    [
      params.companyId,
      params.invoiceId,
      params.connectionId,
      status,
      status === 'registered' ? `ref-${randomUUID()}` : null,
      params.principal === undefined ? 1000 : params.principal,
    ],
  )
  return rows[0]!.id
}

async function insertPayment(
  seed: Pick<Seed, 'companyId' | 'userId'>,
  invoiceId: string,
  amount: number,
  cols: { source?: string | null; date?: string } = {},
  db: Db = getPool(),
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, source)
     VALUES ($1, $2, $3, $4, $5, 'SEK', $6) RETURNING id`,
    [seed.userId, seed.companyId, invoiceId, cols.date ?? '2026-07-02', amount, cols.source === undefined ? 'bank' : cols.source],
  )
  return rows[0]!.id
}

interface ForwardRow {
  id: string
  kind: string
  status: string
  amount: string
  invoice_payment_id: string | null
  credit_invoice_id: string | null
  payment_date: string
  last_error: string | null
  sent_amount: string | null
  ignored_amount: string | null
  forwarded_at: Date | null
  lease_token: string | null
  next_attempt_at: Date | null
}

async function forwards(caseId: string, db: Db = getPool()): Promise<ForwardRow[]> {
  const { rows } = await db.query<ForwardRow>(
    `SELECT id, kind, status, amount::text, invoice_payment_id, credit_invoice_id, payment_date::text,
            last_error, sent_amount::text, ignored_amount::text, forwarded_at, lease_token, next_attempt_at
       FROM public.collection_payment_forwards WHERE case_id = $1 ORDER BY created_at, id`,
    [caseId],
  )
  return rows
}

/** A company with an active connection and a registered case on a 1 000 kr invoice. */
async function caseWorld(options: { status?: 'preparing' | 'submitted' | 'registered'; principal?: number | null } = {}) {
  const seed = await seedCompany()
  const connectionId = await insertConnection(seed)
  const invoiceId = await insertInvoice(seed)
  const caseId = await insertCase({ companyId: seed.companyId, invoiceId, connectionId, ...options })
  return { ...seed, connectionId, invoiceId, caseId }
}

interface Claimed {
  id: string
  case_id: string
  kind: string
  status: string
  attempts: number
  lease_token: string
}

async function claim(companyId: string, limit = 10, db: Db = getPool()): Promise<Claimed[]> {
  const { rows } = await db.query<Claimed>(
    `SELECT id, case_id, kind, status, attempts, lease_token FROM public.claim_collection_forwards($1, 60, $2)`,
    [limit, companyId],
  )
  return rows
}

async function finish(
  row: Pick<Claimed, 'id' | 'lease_token'>,
  result: string,
  extra: { providerRef?: string; sent?: number; ignored?: number; error?: string; retryAt?: string } = {},
): Promise<string> {
  const { rows } = await getPool().query<{ status: string }>(
    `SELECT public.finish_collection_forward($1, $2, $3, $4, $5, $6, $7, $8) AS status`,
    [row.id, row.lease_token, result, extra.providerRef ?? null, extra.sent ?? null, extra.ignored ?? null, extra.error ?? null, extra.retryAt ?? null],
  )
  return rows[0]!.status
}

async function inTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await fn(client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

describe('invoice_payments provenance (pg)', () => {
  it('stores the source and the outside reference, and refuses an unknown source', async () => {
    const w = await caseWorld()
    const { rows } = await getPool().query<{ source: string; external_ref: string }>(
      `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, source, external_ref)
       VALUES ($1, $2, $3, '2026-07-01', 100, 'stripe', 'evt_1') RETURNING source, external_ref`,
      [w.userId, w.companyId, w.invoiceId],
    )
    expect(rows[0]).toEqual({ source: 'stripe', external_ref: 'evt_1' })
    await expect(insertPayment(w, w.invoiceId, 10, { source: 'cash_box' })).rejects.toThrow(/invoice_payments_source_check/)
  })
})

describe('forwards filled by triggers (pg)', () => {
  it('queues every payment on an invoice under collection, from any writer, with its amount and date', async () => {
    const w = await caseWorld()
    const paymentId = await insertPayment(w, w.invoiceId, 400.5, { source: 'manual', date: '2026-07-03' })
    const legacy = await insertPayment(w, w.invoiceId, 100, { source: null })
    const rows = await forwards(w.caseId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      kind: 'payment',
      status: 'pending',
      amount: '400.50',
      invoice_payment_id: paymentId,
      credit_invoice_id: null,
      payment_date: '2026-07-03',
    })
    // A row without a source (SQL RPCs, legacy) is not from the provider: it is reported.
    expect(rows[1]).toMatchObject({ invoice_payment_id: legacy, status: 'pending' })
  })

  it('never queues a payment the provider collected itself', async () => {
    const w = await caseWorld()
    await insertPayment(w, w.invoiceId, 400, { source: 'collections' })
    expect(await forwards(w.caseId)).toEqual([])
  })

  it('queues nothing without a reachable case: none, preparing, refused, withdrawn', async () => {
    const seed = await seedCompany()
    const connectionId = await insertConnection(seed)

    const plain = await insertInvoice(seed)
    await insertPayment(seed, plain, 100)

    const preparing = await insertInvoice(seed)
    const preparingCase = await insertCase({ companyId: seed.companyId, invoiceId: preparing, connectionId, status: 'preparing' })
    await insertPayment(seed, preparing, 100)

    const withdrawn = await insertInvoice(seed)
    const withdrawnCase = await insertCase({ companyId: seed.companyId, invoiceId: withdrawn, connectionId })
    await getPool().query(
      `UPDATE public.collection_cases SET is_open = false, closed_at = now(), stage = 'closed_other', close_reason = 'withdrawn'
        WHERE id = $1`,
      [withdrawnCase],
    )
    await insertPayment(seed, withdrawn, 100)

    const { rows } = await getPool().query(`SELECT 1 FROM public.collection_payment_forwards WHERE company_id = $1`, [seed.companyId])
    expect(rows).toHaveLength(0)
    expect(await forwards(preparingCase)).toEqual([])
  })

  it('queues for a submitted case (sent once registered) and for a case closed as paid in the last 90 days', async () => {
    const submitted = await caseWorld({ status: 'submitted' })
    await insertPayment(submitted, submitted.invoiceId, 100)
    expect(await forwards(submitted.caseId)).toHaveLength(1)

    // The rematch race: the claim was closed as paid, a reported payment is
    // unmatched (the revert reopens the claim) and matched again.
    const paid = await caseWorld()
    await getPool().query(
      `UPDATE public.collection_cases SET is_open = false, closed_at = now(), stage = 'closed_paid', close_reason = 'paid'
        WHERE id = $1`,
      [paid.caseId],
    )
    await insertPayment(paid, paid.invoiceId, 100)
    expect(await forwards(paid.caseId)).toHaveLength(1)

    const old = await caseWorld()
    await getPool().query(
      `UPDATE public.collection_cases SET is_open = false, closed_at = now() - interval '91 days', stage = 'closed_paid',
              close_reason = 'paid' WHERE id = $1`,
      [old.caseId],
    )
    await insertPayment(old, old.invoiceId, 100)
    expect(await forwards(old.caseId)).toEqual([])
  })

  it('queues a payment written by match_batch_allocate', async () => {
    const w = await caseWorld()
    const txId = randomUUID()
    await getPool().query(
      `INSERT INTO public.transactions (id, user_id, company_id, date, description, amount, currency, category)
       VALUES ($1, $2, $3, '2026-07-04', 'Inbetalning', 1000, 'SEK', 'uncategorized')`,
      [txId, w.userId, w.companyId],
    )
    await withUserContext(w.userId, async (client) => {
      const res = await client.query<{ result: { ok: boolean } }>(`SELECT match_batch_allocate($1, $2::jsonb, $3) AS result`, [
        txId,
        JSON.stringify([{ kind: 'customer_invoice', invoice_id: w.invoiceId, amount: 1000 }]),
        w.companyId,
      ])
      expect(res.rows[0]!.result.ok).toBe(true)
      const queued = await client.query<{ status: string; amount: string; payment_date: string }>(
        `SELECT f.status, f.amount::text, f.payment_date::text
           FROM public.collection_payment_forwards f
           JOIN public.invoice_payments ip ON ip.id = f.invoice_payment_id
          WHERE f.case_id = $1 AND ip.transaction_id = $2`,
        [w.caseId, txId],
      )
      expect(queued.rows).toEqual([{ status: 'pending', amount: '1000.00', payment_date: '2026-07-04' }])
    })
  })

  it('queues a payment written by link_invoice_to_voucher', async () => {
    const w = await caseWorld()
    const voucherId = await insertPostedJournalEntry({
      userId: w.userId,
      companyId: w.companyId,
      fiscalPeriodId: w.fiscalPeriodId,
      voucherNumber: Math.floor(Math.random() * 100000),
      entryDate: '2026-07-05',
      description: 'Betalning',
      sourceType: 'manual',
      lines: [
        { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    await withUserContext(w.userId, async (client) => {
      const res = await client.query<{ result: { ok: boolean } }>(
        `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, $5) AS result`,
        [w.invoiceId, voucherId, w.userId, w.companyId, null],
      )
      expect(res.rows[0]!.result).toMatchObject({ ok: true })
      const queued = await client.query<{ status: string; amount: string }>(
        `SELECT status, amount::text FROM public.collection_payment_forwards WHERE case_id = $1`,
        [w.caseId],
      )
      expect(queued.rows).toEqual([{ status: 'pending', amount: '1000.00' }])
    })
  })

  it('a removed payment: reported -> revert_pending, not yet reported -> skipped, a failed report -> skipped', async () => {
    const w = await caseWorld()
    const reported = await insertPayment(w, w.invoiceId, 100)
    const waiting = await insertPayment(w, w.invoiceId, 200)
    const failedReport = await insertPayment(w, w.invoiceId, 300)
    await getPool().query(
      `UPDATE public.collection_payment_forwards SET status = 'forwarded', forwarded_at = now(), sent_amount = amount
        WHERE invoice_payment_id = $1`,
      [reported],
    )
    await getPool().query(`UPDATE public.collection_payment_forwards SET status = 'failed' WHERE invoice_payment_id = $1`, [failedReport])

    await getPool().query(`DELETE FROM public.invoice_payments WHERE id = ANY($1::uuid[])`, [[reported, waiting, failedReport]])
    const byPayment = new Map((await forwards(w.caseId)).map((r) => [r.invoice_payment_id, r]))
    expect(byPayment.get(reported)).toMatchObject({ status: 'revert_pending', last_error: null })
    expect(byPayment.get(waiting)).toMatchObject({ status: 'skipped', last_error: 'payment_removed' })
    expect(byPayment.get(failedReport)).toMatchObject({ status: 'skipped' })
  })

  it('a failed submission skips what waited for the case', async () => {
    const w = await caseWorld({ status: 'submitted' })
    await insertPayment(w, w.invoiceId, 100)
    await getPool().query(
      `UPDATE public.collection_cases SET submission_status = 'failed', is_open = false, closed_at = now() WHERE id = $1`,
      [w.caseId],
    )
    expect(await forwards(w.caseId)).toMatchObject([{ status: 'skipped', last_error: 'case_submission_failed' }])
  })
})

describe('credit note forwards (pg)', () => {
  it('queues a credit note issued against a case invoice, for the customer share, inserted as sent or flipped from draft', async () => {
    const w = await caseWorld()
    const inserted = await insertInvoice(w, { credited_invoice_id: w.invoiceId, total: -400, subtotal: -320, vat_amount: -80, status: 'sent' })
    const draft = await insertInvoice(w, { credited_invoice_id: w.invoiceId, total: -100, subtotal: -80, vat_amount: -20, status: 'draft' })
    let rows = await forwards(w.caseId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'credit_note', credit_invoice_id: inserted, amount: '400.00', status: 'pending', payment_date: '2026-06-01' })

    await getPool().query(`UPDATE public.invoices SET status = 'sent', invoice_number = 'K-1' WHERE id = $1`, [draft])
    rows = await forwards(w.caseId)
    expect(rows.map((r) => [r.credit_invoice_id, r.amount])).toEqual([
      [inserted, '400.00'],
      [draft, '100.00'],
    ])
  })

  it('withdraws a credit note whose issue failed, reports it again when it is issued again, and drops a removed one', async () => {
    const w = await caseWorld()
    const note = await insertInvoice(w, { credited_invoice_id: w.invoiceId, total: -100, subtotal: -80, vat_amount: -20, status: 'sent' })
    await getPool().query(`UPDATE public.invoices SET status = 'draft' WHERE id = $1`, [note])
    expect(await forwards(w.caseId)).toMatchObject([{ status: 'skipped', last_error: 'credit_note_withdrawn' }])

    await getPool().query(`UPDATE public.invoices SET status = 'sent' WHERE id = $1`, [note])
    expect(await forwards(w.caseId)).toMatchObject([{ status: 'pending', last_error: null }])

    const removed = await insertInvoice(w, { credited_invoice_id: w.invoiceId, total: -50, subtotal: -40, vat_amount: -10, status: 'sent' })
    await getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [removed])
    const rows = await forwards(w.caseId)
    expect(rows.find((r) => r.credit_invoice_id === removed)).toMatchObject({ status: 'skipped', last_error: 'credit_note_removed' })
  })

  it('queues no credit note for an invoice without an open case, nor a draft one', async () => {
    const seed = await seedCompany()
    const invoiceId = await insertInvoice(seed)
    await insertInvoice(seed, { credited_invoice_id: invoiceId, total: -100, subtotal: -80, vat_amount: -20, status: 'sent' })
    const { rows } = await getPool().query(`SELECT 1 FROM public.collection_payment_forwards WHERE company_id = $1`, [seed.companyId])
    expect(rows).toHaveLength(0)
  })
})

describe('claim_collection_forwards and finish_collection_forward (pg)', () => {
  it('hands out one row per case per claim, a revert first, and waits for a leased head', async () => {
    const w = await caseWorld()
    const first = await insertPayment(w, w.invoiceId, 100)
    await insertPayment(w, w.invoiceId, 200)
    const reported = await insertPayment(w, w.invoiceId, 300)
    await getPool().query(
      `UPDATE public.collection_payment_forwards SET status = 'forwarded', forwarded_at = now(), sent_amount = amount
        WHERE invoice_payment_id = $1`,
      [reported],
    )
    await getPool().query(`DELETE FROM public.invoice_payments WHERE id = $1`, [reported])

    const one = await claim(w.companyId)
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ status: 'revert_pending', attempts: 1 })
    // The head is leased: the case waits whole.
    expect(await claim(w.companyId)).toEqual([])
    expect(await finish(one[0]!, 'reverted')).toBe('reverted')

    const next = await claim(w.companyId)
    expect(next).toHaveLength(1)
    const rows = await forwards(w.caseId)
    expect(rows.find((r) => r.id === next[0]!.id)!.invoice_payment_id).toBe(first)
  })

  it('never hands one row to two concurrent callers', async () => {
    const w = await caseWorld()
    const other = await insertInvoice(w)
    const otherCase = await insertCase({ companyId: w.companyId, invoiceId: other, connectionId: w.connectionId })
    await insertPayment(w, w.invoiceId, 100)
    await insertPayment(w, other, 100)

    const a = await getClient()
    try {
      await a.query('BEGIN')
      const held = await claim(w.companyId, 10, a)
      expect(held).toHaveLength(2)
      // The first caller's transaction still holds the rows: the second skips them.
      expect(await claim(w.companyId)).toEqual([])
      await a.query('COMMIT')
    } finally {
      a.release()
    }
    // Committed leases keep them out too.
    expect(await claim(w.companyId)).toEqual([])
    expect((await forwards(otherCase))[0]!.lease_token).not.toBeNull()

    const parallel = await caseWorld()
    for (let i = 0; i < 6; i++) {
      const inv = await insertInvoice(parallel)
      await insertCase({ companyId: parallel.companyId, invoiceId: inv, connectionId: parallel.connectionId })
      await insertPayment(parallel, inv, 10 + i)
    }
    const [x, y] = await Promise.all([claim(parallel.companyId, 4), claim(parallel.companyId, 4)])
    const ids = [...x, ...y].map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('waits for a resting row and for a case that is not registered yet', async () => {
    const w = await caseWorld({ status: 'submitted' })
    await insertPayment(w, w.invoiceId, 100)
    expect(await claim(w.companyId)).toEqual([])
    await getPool().query(
      `UPDATE public.collection_cases SET submission_status = 'registered', provider_case_ref = $2 WHERE id = $1`,
      [w.caseId, `ref-${randomUUID()}`],
    )
    const [row] = await claim(w.companyId)
    const retryAt = new Date(Date.now() + 3_600_000).toISOString()
    expect(await finish(row!, 'retry', { error: 'CONNECTOR_TIMEOUT', retryAt })).toBe('pending')
    expect(await claim(w.companyId)).toEqual([])
    expect((await forwards(w.caseId))[0]).toMatchObject({ status: 'pending', last_error: 'CONNECTOR_TIMEOUT', lease_token: null })
  })

  it('finishes only with the lease token, and records what the provider holds', async () => {
    const w = await caseWorld()
    await insertPayment(w, w.invoiceId, 500)
    const [row] = await claim(w.companyId)
    expect(await finish({ id: row!.id, lease_token: randomUUID() }, 'reported', { sent: 500 })).toBe('lease_lost')
    expect((await forwards(w.caseId))[0]!.status).toBe('pending')

    expect(await finish(row!, 'reported', { providerRef: 'p-1', sent: 450, ignored: 50 })).toBe('forwarded')
    const [stored] = await forwards(w.caseId)
    expect(stored).toMatchObject({ status: 'forwarded', sent_amount: '450.00', ignored_amount: '50.00', lease_token: null })
    expect(stored!.forwarded_at).not.toBeNull()
  })

  it('a payment removed while its report was in flight is reverted once the report lands', async () => {
    const w = await caseWorld()
    const paymentId = await insertPayment(w, w.invoiceId, 500)
    const [row] = await claim(w.companyId)
    await getPool().query(`DELETE FROM public.invoice_payments WHERE id = $1`, [paymentId])
    expect(await finish(row!, 'reported', { sent: 500, ignored: 0 })).toBe('revert_pending')
    expect((await forwards(w.caseId))[0]).toMatchObject({ status: 'revert_pending', last_error: 'payment_removed_in_flight' })

    const other = await caseWorld()
    const gone = await insertPayment(other, other.invoiceId, 500)
    const [inFlight] = await claim(other.companyId)
    await getPool().query(`DELETE FROM public.invoice_payments WHERE id = $1`, [gone])
    // The report did not get through: nothing to drop, it stays skipped.
    expect(await finish(inFlight!, 'failed', { error: 'CONNECTOR_REJECTED' })).toBe('skipped')
  })

  it('refuses a claim outside its bounds', async () => {
    await expect(getPool().query(`SELECT * FROM public.claim_collection_forwards(0, 60)`)).rejects.toThrow(/p_limit/)
    await expect(getPool().query(`SELECT * FROM public.claim_collection_forwards(10, 1)`)).rejects.toThrow(/p_lease_seconds/)
  })
})

describe('seed_collection_forwards (pg)', () => {
  it('records the handover request\'s payments as forwarded, a removed one as revert_pending, and skips refs that are not rows', async () => {
    const w = await caseWorld()
    // Recorded before the handover: the case was preparing, so nothing was queued.
    await getPool().query(`UPDATE public.collection_cases SET submission_status = 'preparing', provider_case_ref = NULL WHERE id = $1`, [w.caseId])
    const kept = await insertPayment(w, w.invoiceId, 100)
    const removedId = randomUUID()
    const foreign = await insertPayment(w, await insertInvoice(w), 50)
    const note = await insertInvoice(w, { credited_invoice_id: w.invoiceId, total: -40, subtotal: -32, vat_amount: -8, status: 'sent' })
    expect(await forwards(w.caseId)).toEqual([])

    const { rows } = await runAsServiceRole((client) =>
      client.query<{ n: number }>(`SELECT public.seed_collection_forwards($1, $2::jsonb, $3::jsonb) AS n`, [
        w.caseId,
        JSON.stringify([
          { paymentRef: kept, date: '2026-07-01', amount: 100 },
          { paymentRef: removedId, date: '2026-07-01', amount: 25 },
          { paymentRef: foreign, date: '2026-07-01', amount: 50 },
          { paymentRef: `${w.invoiceId}:prior`, date: '2026-06-15', amount: 75 },
        ]),
        JSON.stringify([{ creditRef: note, date: '2026-06-20', amount: 40 }]),
      ]),
    )
    expect(rows[0]!.n).toBe(3)
    // One transaction: the rows share created_at, so compare them in a fixed order.
    const seeded = (await forwards(w.caseId)).sort((a, b) => Number(b.amount) - Number(a.amount))
    expect(seeded.map((r) => [r.kind, r.invoice_payment_id ?? r.credit_invoice_id, r.status, r.sent_amount])).toEqual([
      ['payment', kept, 'forwarded', '100.00'],
      ['credit_note', note, 'forwarded', '40.00'],
      ['payment', removedId, 'revert_pending', '25.00'],
    ])
    // Removing a seeded payment reverts it at the provider.
    await getPool().query(`DELETE FROM public.invoice_payments WHERE id = $1`, [kept])
    expect((await forwards(w.caseId)).find((r) => r.invoice_payment_id === kept)!.status).toBe('revert_pending')
  })

  it('turns a pending row of a seeded payment into forwarded, never a second report', async () => {
    const w = await caseWorld({ status: 'submitted' })
    const paymentId = await insertPayment(w, w.invoiceId, 100)
    expect(await forwards(w.caseId)).toMatchObject([{ status: 'pending' }])
    await runAsServiceRole((client) =>
      client.query(`SELECT public.seed_collection_forwards($1, $2::jsonb, '[]'::jsonb)`, [
        w.caseId,
        JSON.stringify([{ paymentRef: paymentId, date: '2026-07-02', amount: 100 }]),
      ]),
    )
    expect(await forwards(w.caseId)).toMatchObject([{ status: 'forwarded', invoice_payment_id: paymentId }])
  })
})

describe('a payment the provider collected (pg)', () => {
  it('cannot be deleted, directly or by the storno path, nor re-labelled, except by the rebook service', async () => {
    const w = await caseWorld()
    const collected = await insertPayment(w, w.invoiceId, 300, { source: 'collections' })
    await expect(getPool().query(`DELETE FROM public.invoice_payments WHERE id = $1`, [collected])).rejects.toThrow(
      /COLLECTED_PAYMENT_DELETE_BLOCKED/,
    )
    // The storno path (payment-sync deletePaymentRows) deletes on the service role.
    await expect(
      runAsServiceRole((client) => client.query(`DELETE FROM public.invoice_payments WHERE id = $1`, [collected])),
    ).rejects.toThrow(/COLLECTED_PAYMENT_DELETE_BLOCKED/)
    await expect(getPool().query(`UPDATE public.invoice_payments SET source = 'manual' WHERE id = $1`, [collected])).rejects.toThrow(
      /COLLECTED_PAYMENT_SOURCE_LOCKED/,
    )
    await expect(getPool().query(`UPDATE public.invoice_payments SET source = NULL WHERE id = $1`, [collected])).rejects.toThrow(
      /COLLECTED_PAYMENT_SOURCE_LOCKED/,
    )
    // Removing the invoice would take the row with it: refused as well.
    await expect(getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [w.invoiceId])).rejects.toThrow(
      /COLLECTED_PAYMENT_DELETE_BLOCKED/,
    )
    // A sandbox flag alone, outside the teardown function, opens nothing.
    await expect(
      inTransaction(async (client) => {
        await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
        await client.query(`DELETE FROM public.invoice_payments WHERE id = $1`, [collected])
      }),
    ).rejects.toThrow(/COLLECTED_PAYMENT_DELETE_BLOCKED/)

    await inTransaction(async (client) => {
      await client.query(`SELECT set_config('gnubok.collections_rebook', 'true', true)`)
      await client.query(`DELETE FROM public.invoice_payments WHERE id = $1`, [collected])
    })
    const { rows } = await getPool().query(`SELECT 1 FROM public.invoice_payments WHERE id = $1`, [collected])
    expect(rows).toHaveLength(0)
    // It was never reported, so its removal reports nothing either.
    expect(await forwards(w.caseId)).toEqual([])

    // A legacy row (no source) may be given one, but never 'collections'.
    const legacy = await insertPayment(w, w.invoiceId, 10, { source: null })
    await expect(getPool().query(`UPDATE public.invoice_payments SET source = 'collections' WHERE id = $1`, [legacy])).rejects.toThrow(
      /COLLECTED_PAYMENT_SOURCE_LOCKED/,
    )
    await getPool().query(`UPDATE public.invoice_payments SET source = 'bank' WHERE id = $1`, [legacy])
    await getPool().query(`UPDATE public.invoice_payments SET source = 'manual' WHERE id = $1`, [legacy])
    const { rows: relabelled } = await getPool().query<{ source: string }>(
      `SELECT source FROM public.invoice_payments WHERE id = $1`,
      [legacy],
    )
    expect(relabelled).toEqual([{ source: 'manual' }])
  })
})

describe('Att göra, access and teardown (pg)', () => {
  it('lists a failed forward and an amount the provider does not hold until a person handles them', async () => {
    const w = await caseWorld()
    const failedPayment = await insertPayment(w, w.invoiceId, 100)
    const excessPayment = await insertPayment(w, w.invoiceId, 200)
    await getPool().query(`UPDATE public.collection_payment_forwards SET status = 'failed', last_error = 'X' WHERE invoice_payment_id = $1`, [
      failedPayment,
    ])
    await getPool().query(
      `UPDATE public.collection_payment_forwards
          SET status = 'forwarded', forwarded_at = now(), sent_amount = 150, ignored_amount = 50
        WHERE invoice_payment_id = $1`,
      [excessPayment],
    )
    const reasons = async () =>
      (
        await getPool().query<{ reason: string }>(
          `SELECT reason FROM public.collection_attention_case_ids($1) WHERE case_id = $2 ORDER BY reason`,
          [w.companyId, w.caseId],
        )
      ).rows.map((r) => r.reason)
    expect(await reasons()).toEqual(['forward_failed', 'payment_excess'])

    await getPool().query(
      `UPDATE public.collection_payment_forwards SET attention_resolved_at = now(), attention_resolved_by = $2
        WHERE invoice_payment_id = $1`,
      [excessPayment, w.userId],
    )
    expect(await reasons()).toEqual(['forward_failed'])
    await getPool().query(`UPDATE public.collection_payment_forwards SET status = 'pending' WHERE invoice_payment_id = $1`, [failedPayment])
    expect(await reasons()).toEqual([])
  })

  it('members read their own company\'s forwards only and write none; grants', async () => {
    const w = await caseWorld()
    await insertPayment(w, w.invoiceId, 100)
    const outsider = await insertAuthUser()
    const otherCompany = await seedCompany()
    await insertCompanyMember({ companyId: otherCompany.companyId, userId: outsider, role: 'owner' })

    await withUserContext(w.userId, async (client) => {
      const own = await client.query(`SELECT 1 FROM public.collection_payment_forwards WHERE case_id = $1`, [w.caseId])
      expect(own.rows).toHaveLength(1)
      await expect(
        client.query(
          `INSERT INTO public.collection_payment_forwards (company_id, case_id, kind, invoice_payment_id, amount, payment_date)
           VALUES ($1, $2, 'payment', $3, 1, '2026-07-01')`,
          [w.companyId, w.caseId, randomUUID()],
        ),
      ).rejects.toThrow(/permission denied|row-level security/)
    })
    await withUserContext(outsider, async (client) => {
      const foreign = await client.query(`SELECT 1 FROM public.collection_payment_forwards WHERE case_id = $1`, [w.caseId])
      expect(foreign.rows).toHaveLength(0)
      const attention = await client.query(`SELECT 1 FROM public.collection_attention_case_ids($1)`, [w.companyId])
      expect(attention.rows).toHaveLength(0)
    })

    const { rows } = await getPool().query<{ anon_select: boolean; auth_insert: boolean; service_insert: boolean }>(
      `SELECT has_table_privilege('anon', 'public.collection_payment_forwards', 'SELECT') AS anon_select,
              has_table_privilege('authenticated', 'public.collection_payment_forwards', 'INSERT') AS auth_insert,
              has_table_privilege('service_role', 'public.collection_payment_forwards', 'INSERT') AS service_insert`,
    )
    expect(rows[0]).toEqual({ anon_select: false, auth_insert: false, service_insert: true })
  })

  it('keeps a forward to its case\'s company and a credit forward to the case\'s invoice', async () => {
    const w = await caseWorld()
    const other = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.collection_payment_forwards (company_id, case_id, kind, invoice_payment_id, amount, payment_date)
         VALUES ($1, $2, 'payment', $3, 1, '2026-07-01')`,
        [other.companyId, w.caseId, randomUUID()],
      ),
    ).rejects.toThrow(/belongs to its case's company/)
    const unrelated = await insertInvoice(w, { total: -10, subtotal: -8, vat_amount: -2, credited_invoice_id: await insertInvoice(w), status: 'draft' })
    await expect(
      getPool().query(
        `INSERT INTO public.collection_payment_forwards (company_id, case_id, kind, credit_invoice_id, amount, payment_date)
         VALUES ($1, $2, 'credit_note', $3, 10, '2026-07-01')`,
        [w.companyId, w.caseId, unrelated],
      ),
    ).rejects.toThrow(/credits the case's invoice/)
  })

  it('tears down a sandbox company with forwards and a collected payment, and leaves a real one alone', async () => {
    const sandbox = await seedCompany()
    await getPool().query(`INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`, [
      sandbox.userId,
      sandbox.companyId,
    ])
    const connectionId = await insertConnection(sandbox, 'fake')
    const invoiceId = await insertInvoice(sandbox)
    const caseId = await insertCase({ companyId: sandbox.companyId, invoiceId, connectionId })
    await insertPayment(sandbox, invoiceId, 100)
    await insertPayment(sandbox, invoiceId, 200, { source: 'collections' })
    await insertInvoice(sandbox, { credited_invoice_id: invoiceId, total: -50, subtotal: -40, vat_amount: -10, status: 'sent' })
    expect(await forwards(caseId)).toHaveLength(2)

    const real = await caseWorld()
    await getPool().query(`INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, false)`, [
      real.userId,
      real.companyId,
    ])
    await insertPayment(real, real.invoiceId, 100)

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])
    const left = await getPool().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM public.collection_payment_forwards WHERE company_id = $1)
            + (SELECT count(*) FROM public.invoice_payments WHERE company_id = $1)
            + (SELECT count(*) FROM public.collection_cases WHERE company_id = $1) AS n`,
      [sandbox.companyId],
    )
    expect(Number(left.rows[0]!.n)).toBe(0)
    expect(await forwards(real.caseId)).toHaveLength(1)
  })
})
