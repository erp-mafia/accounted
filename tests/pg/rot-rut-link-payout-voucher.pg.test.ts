/**
 * pg-real tests for link_rot_rut_payout_voucher and the settlement release
 * on reversal (20260923100000_rot_rut_link_payout_voucher.sql).
 *
 * A payout booked by hand (1930 / 3740 / 1513) could not be connected to its
 * begäran, which then read "Uppladdad" forever. The RPC attaches the existing
 * verifikat and must never write to the journal. Reversing that verifikat
 * must hand the begäran back so it can be settled again.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertPostedJournalEntry, seedCompany, type PostedJournalEntryLine } from './fixtures'

type Seeded = Awaited<ReturnType<typeof seedCompany>>

interface LinkResult {
  ok: boolean
  code?: string
  dry_run?: boolean
  already_linked?: boolean
  expected_total?: number
  voucher_1513_credit?: number
  bank_amount?: number
  rounding?: number
  requests?: Array<{ request_id: string; status: string; amount: number }>
  details?: Record<string, unknown>
}

async function seedRequest(
  company: Seeded,
  params: { requested: number[]; decidedTotal?: number | null; status?: string },
): Promise<string> {
  const requestId = randomUUID()
  const total = params.requested.reduce((sum, amount) => sum + amount, 0)
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests
      (id, company_id, user_id, deduction_type, name, status, requested_total, decided_total, file_name)
     VALUES ($1, $2, $3, 'rut', 'RUT 2026-08-25', $4, $5, $6, 'rut.xml')`,
    [requestId, company.companyId, company.userId, params.status ?? 'submitted', total, params.decidedTotal ?? null],
  )
  for (const amount of params.requested) {
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Kund', 'individual')`,
      [customerId, company.userId, company.companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
        (id, user_id, company_id, customer_id, invoice_date, due_date,
         currency, vat_treatment, vat_rate, deduction_total)
       VALUES ($1, $2, $3, $4, '2026-08-01', '2026-08-31', 'SEK', 'standard_25', 25, $5)`,
      [invoiceId, company.userId, company.companyId, customerId, amount],
    )
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_request_items (request_id, invoice_id, requested_amount)
       VALUES ($1, $2, $3)`,
      [requestId, invoiceId, amount],
    )
  }
  return requestId
}

function payoutLines(bank: number, receivable: number): PostedJournalEntryLine[] {
  const rounding = Math.round((receivable - bank) * 100) / 100
  return [
    { accountNumber: '1930', debitAmount: bank, creditAmount: 0 },
    ...(rounding > 0 ? [{ accountNumber: '3740', debitAmount: rounding, creditAmount: 0 }] : []),
    { accountNumber: '1513', debitAmount: 0, creditAmount: receivable },
  ]
}

async function seedVoucher(company: Seeded, lines: PostedJournalEntryLine[], sourceType = 'manual') {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    voucherNumber: Math.floor(Math.random() * 1_000_000),
    entryDate: '2026-09-01',
    description: 'Utbetalning RUT',
    sourceType,
    lines,
  })
}

async function link(
  companyId: string,
  requestIds: string[],
  voucherId: string,
  dryRun = false,
): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    'SELECT public.link_rot_rut_payout_voucher($1, $2::uuid[], $3, $4) AS result',
    [companyId, requestIds, voucherId, dryRun],
  )
  return rows[0].result
}

async function requestRow(id: string) {
  const { rows } = await getPool().query<{
    status: string
    settlement_journal_entry_id: string | null
    decided_total: string | null
    decided_at: string | null
  }>(
    `SELECT status, settlement_journal_entry_id, decided_total::text, decided_at::text
     FROM public.rot_rut_payout_requests WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function journalCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM public.journal_entries WHERE company_id = $1',
    [companyId],
  )
  return Number(rows[0].n)
}

describe('link_rot_rut_payout_voucher', () => {
  it('links a hand-booked payout with öre rounding and writes no journal entry', async () => {
    const company = await seedCompany()
    const requestId = await seedRequest(company, { requested: [671], decidedTotal: 671 })
    const voucherId = await seedVoucher(company, payoutLines(671, 671.25))
    const before = await journalCount(company.companyId)

    const result = await link(company.companyId, [requestId], voucherId)

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      already_linked: false,
      expected_total: 671,
      voucher_1513_credit: 671.25,
      bank_amount: 671,
      rounding: 0.25,
    })
    expect(await requestRow(requestId)).toMatchObject({
      status: 'paid',
      settlement_journal_entry_id: voucherId,
      decided_total: '671.00',
    })
    const { rows: items } = await getPool().query<{ decided_amount: string }>(
      'SELECT decided_amount::text FROM public.rot_rut_payout_request_items WHERE request_id = $1',
      [requestId],
    )
    expect(items.map((item) => item.decided_amount)).toEqual(['671.00'])
    expect(await journalCount(company.companyId)).toBe(before)
  })

  it('dry run checks everything and writes nothing', async () => {
    const company = await seedCompany()
    const requestId = await seedRequest(company, { requested: [1000] })
    const voucherId = await seedVoucher(company, payoutLines(1000, 1000))

    expect(await link(company.companyId, [requestId], voucherId, true)).toMatchObject({
      ok: true,
      dry_run: true,
    })
    expect(await requestRow(requestId)).toMatchObject({
      status: 'submitted',
      settlement_journal_entry_id: null,
      decided_at: null,
    })
  })

  it('links a bundle and marks a reduced beslut partially paid', async () => {
    const company = await seedCompany()
    const full = await seedRequest(company, { requested: [500] })
    const reduced = await seedRequest(company, { requested: [800], decidedTotal: 600 })
    const voucherId = await seedVoucher(company, payoutLines(1100, 1100))

    const result = await link(company.companyId, [full, reduced], voucherId)

    expect(result.ok).toBe(true)
    expect((await requestRow(full)).status).toBe('paid')
    expect((await requestRow(reduced)).status).toBe('partially_paid')
  })

  it('a double link is idempotent', async () => {
    const company = await seedCompany()
    const requestId = await seedRequest(company, { requested: [1000] })
    const voucherId = await seedVoucher(company, payoutLines(1000, 1000))

    expect((await link(company.companyId, [requestId], voucherId)).ok).toBe(true)
    expect(await link(company.companyId, [requestId], voucherId)).toMatchObject({
      ok: true,
      already_linked: true,
    })
  })

  it('refuses a begäran already linked to another verifikat', async () => {
    const company = await seedCompany()
    const requestId = await seedRequest(company, { requested: [1000] })
    const first = await seedVoucher(company, payoutLines(1000, 1000))
    const second = await seedVoucher(company, payoutLines(1000, 1000))

    expect((await link(company.companyId, [requestId], first)).ok).toBe(true)
    expect((await link(company.companyId, [requestId], second)).code).toBe('ROT_RUT_LINK_ALREADY_SETTLED')
  })

  it('two parallel links of one verifikat end with one winner', async () => {
    const company = await seedCompany()
    const a = await seedRequest(company, { requested: [1000] })
    const b = await seedRequest(company, { requested: [1000] })
    const voucherId = await seedVoucher(company, payoutLines(1000, 1000))

    const results = await Promise.all([
      link(company.companyId, [a], voucherId),
      link(company.companyId, [b], voucherId),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)?.code).toBe('ROT_RUT_LINK_VOUCHER_IN_USE')
    const { rows } = await getPool().query(
      'SELECT id FROM public.rot_rut_payout_requests WHERE settlement_journal_entry_id = $1',
      [voucherId],
    )
    expect(rows).toHaveLength(1)
  })

  it('refuses amounts that do not match the begäran', async () => {
    const company = await seedCompany()
    const requestId = await seedRequest(company, { requested: [1000] })
    const tooSmall = await seedVoucher(company, payoutLines(999, 999))
    const tooLarge = await seedVoucher(company, payoutLines(1001, 1001))
    const noReceivable = await seedVoucher(company, [
      { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
    ])

    for (const voucherId of [tooSmall, tooLarge, noReceivable]) {
      expect((await link(company.companyId, [requestId], voucherId)).code).toBe('ROT_RUT_LINK_AMOUNT_MISMATCH')
    }
    expect((await requestRow(requestId)).settlement_journal_entry_id).toBeNull()
  })

  it('refuses cancelled begäran and reversed or storno verifikat', async () => {
    const company = await seedCompany()
    const cancelled = await seedRequest(company, { requested: [1000], status: 'cancelled' })
    const open = await seedRequest(company, { requested: [1000] })
    const voucherId = await seedVoucher(company, payoutLines(1000, 1000))
    const storno = await seedVoucher(company, payoutLines(1000, 1000), 'storno')
    const reversed = await seedVoucher(company, payoutLines(1000, 1000))
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [reversed])

    expect((await link(company.companyId, [cancelled], voucherId)).code).toBe('ROT_RUT_SETTLE_INVALID_STATE')
    expect((await link(company.companyId, [open], storno)).code).toBe('ROT_RUT_LINK_VOUCHER_NOT_ELIGIBLE')
    expect((await link(company.companyId, [open], reversed)).code).toBe('ROT_RUT_LINK_VOUCHER_NOT_ELIGIBLE')
  })

  it('cross-company access is refused, whichever side is foreign', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const myRequest = await seedRequest(mine, { requested: [1000] })
    const theirRequest = await seedRequest(theirs, { requested: [1000] })
    const myVoucher = await seedVoucher(mine, payoutLines(1000, 1000))
    const theirVoucher = await seedVoucher(theirs, payoutLines(1000, 1000))

    expect((await link(mine.companyId, [theirRequest], myVoucher)).code).toBe('ROT_RUT_REQUEST_NOT_FOUND')
    expect((await link(mine.companyId, [myRequest], theirVoucher)).code).toBe('ROT_RUT_LINK_VOUCHER_NOT_FOUND')

    // A member of the other company sees nothing under RLS, even when it
    // names the right company id.
    const result = await withUserContext(theirs.userId, async (client) => {
      const { rows } = await client.query<{ result: LinkResult }>(
        'SELECT public.link_rot_rut_payout_voucher($1, $2::uuid[], $3, false) AS result',
        [mine.companyId, [myRequest], myVoucher],
      )
      return rows[0].result
    })
    expect(result.code).toBe('ROT_RUT_REQUEST_NOT_FOUND')
    expect((await requestRow(myRequest)).settlement_journal_entry_id).toBeNull()
  })

  it('a reversal releases the link and keeps the beslut', async () => {
    const company = await seedCompany()
    const requestId = await seedRequest(company, { requested: [1000], decidedTotal: 1000 })
    const voucherId = await seedVoucher(company, payoutLines(1000, 1000))
    expect((await link(company.companyId, [requestId], voucherId)).ok).toBe(true)

    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [voucherId])

    expect(await requestRow(requestId)).toMatchObject({
      settlement_journal_entry_id: null,
      status: 'paid',
      decided_total: '1000.00',
    })
    // And it can be settled again.
    const again = await seedVoucher(company, payoutLines(1000, 1000))
    expect((await link(company.companyId, [requestId], again)).ok).toBe(true)
  })
})
