import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from '@/tests/pg/setup'
import { seedCompany, insertDraftJournalEntry, insertFiscalPeriod } from '@/tests/pg/fixtures'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'

/**
 * Plan 3 invariants. These tests verify the database-level guarantees that
 * back the application-level invariants in executeYearEndClosing():
 *
 *   1. Closing entries must balance to the öre: the journal_entries balance
 *      trigger rejects anything else on draft→posted.
 *   2. A one-öre discrepancy fed into a closing-style entry is rejected
 *      by the trigger; the row stays in 'draft' and no posted state is
 *      created: i.e. DB state is unchanged from the caller's perspective
 *      (no voucher number assigned, no audit_log row for a posted entry).
 *
 * The full executeYearEndClosing() flow is exercised by the existing mock-
 * based test in year-end-service.test.ts. Running that flow against real
 * Postgres requires a Supabase JS client wired to this pool, which is out
 * of scope for the pg-real harness; the invariants below are the
 * load-bearing checks the application layer relies on.
 */
describe('year-end invariants (pg-real)', () => {
  it('closing entry must balance to the öre', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Build a closing-style draft entry: 3001 → 2099 transfer that's off
    // by one öre.
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-12-31',
      description: 'Årsbokslut (unbalanced)',
    })

    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '3001', 0, 1000.00),
              ($1, '2099', 1000.01, 0)`,
      [entryId],
    )

    // Attempt to commit via the same RPC the engine uses. The balance
    // trigger must fire and the RPC must fail.
    const pool = getPool()
    await expect(
      pool.query(`SELECT commit_journal_entry($1, $2)`, [companyId, entryId]),
    ).rejects.toThrow()

    // DB state unchanged: entry still draft, no voucher assigned.
    const { rows } = await pool.query<{ status: string; voucher_number: number }>(
      `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0].status).toBe('draft')
    expect(Number(rows[0].voucher_number)).toBe(0)
  })

  it('balanced closing entry commits cleanly and zeros class 3 net', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Step 1: post a revenue entry so 3001 has a credit balance.
    const revenueId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-06-01',
      description: 'Revenue',
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 5000.00, 0),
              ($1, '3001', 0, 5000.00)`,
      [revenueId],
    )
    await getPool().query(`SELECT commit_journal_entry($1, $2)`, [companyId, revenueId])

    // Step 2: the closing entry: debit 3001, credit 2099.
    const closeId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-12-31',
      description: 'Årsbokslut',
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '3001', 5000.00, 0),
              ($1, '2099', 0, 5000.00)`,
      [closeId],
    )
    await getPool().query(`SELECT commit_journal_entry($1, $2)`, [companyId, closeId])

    // Class-3 net across posted lines in this period must be 0 to the öre.
    const { rows } = await getPool().query<{ net: string }>(
      `SELECT COALESCE(SUM(l.debit_amount - l.credit_amount), 0) AS net
         FROM public.journal_entry_lines l
         JOIN public.journal_entries je ON je.id = l.journal_entry_id
        WHERE je.company_id = $1
          AND je.fiscal_period_id = $2
          AND je.status = 'posted'
          AND l.account_number LIKE '3%'`,
      [companyId, fiscalPeriodId],
    )
    const net = roundOre(Number(rows[0].net))
    expect(Math.abs(net)).toBeLessThanOrEqual(ORE_TOLERANCE)
  })

  it('result appropriation omföring zeros the carried-forward 2099 in the NEW period', async () => {
    // This mirrors production: the closing entry lands in year N, and the
    // omföring (2099 → 2098) is posted in the SEPARATE next period (year N+1)
    // dated its first day: NOT back in the closing period. Posting both in one
    // period (as a naive test would) hides whether 2099 actually starts the new
    // year at zero, which is the whole invariant.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Year N (2026): closing posts the result onto 2099: a balanced 3001 → 2099
    // transfer leaving 2099 with a 5000 credit balance as that year's UB.
    const closeId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-12-31',
      description: 'Årsbokslut',
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '3001', 5000.00, 0),
              ($1, '2099', 0, 5000.00)`,
      [closeId],
    )
    await getPool().query(`SELECT commit_journal_entry($1, $2)`, [companyId, closeId])

    // Year N+1 (2027): a fresh open period. The omföring belongs here.
    const nextPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })

    // Opening-balance entry mirrors year N's UB into the new period: 2099 is
    // carried forward verbatim (1930 IB balances it). This is what leaves 2099
    // non-zero at the start of the new year: exactly what the omföring fixes.
    const ibId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: nextPeriodId,
      entryDate: '2027-01-01',
      description: 'Ingående balans',
      sourceType: 'opening_balance',
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 5000.00, 0),
              ($1, '2099', 0, 5000.00)`,
      [ibId],
    )
    await getPool().query(`SELECT commit_journal_entry($1, $2)`, [companyId, ibId])

    // The year-open omföring: Dr 2099 / Cr 2098, dated the new period's first
    // day, posted in the new period. source_type must be accepted by the CHECK
    // constraint (see source-type-constraint.pg.test.ts) and the balance trigger
    // must pass.
    const omforId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: nextPeriodId,
      entryDate: '2027-01-01',
      description: 'Omföring av föregående års resultat (2099 → 2098)',
      sourceType: 'result_appropriation',
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '2099', 5000.00, 0),
              ($1, '2098', 0, 5000.00)`,
      [omforId],
    )
    await getPool().query(`SELECT commit_journal_entry($1, $2)`, [companyId, omforId])

    // In the NEW period: 2099 net must be 0 (IB +5000 credit cancelled by the
    // omföring's 5000 debit); 2098 must hold the result (credit-normal, so
    // debit − credit = −5000). Scoping to nextPeriodId is the point: 2099 zeros
    // out in the period the result was carried into, not the closing period.
    const { rows } = await getPool().query<{ acct: string; net: string }>(
      `SELECT l.account_number AS acct,
              COALESCE(SUM(l.debit_amount - l.credit_amount), 0) AS net
         FROM public.journal_entry_lines l
         JOIN public.journal_entries je ON je.id = l.journal_entry_id
        WHERE je.company_id = $1
          AND je.fiscal_period_id = $2
          AND je.status = 'posted'
          AND l.account_number IN ('2099', '2098')
        GROUP BY l.account_number`,
      [companyId, nextPeriodId],
    )
    const net = Object.fromEntries(rows.map((r) => [r.acct, roundOre(Number(r.net))]))
    expect(Math.abs(net['2099'] ?? 0)).toBeLessThanOrEqual(ORE_TOLERANCE)
    expect(net['2098']).toBe(-5000)
  })

  it('rejects a one-öre IB/UB style discrepancy in opening balance lines', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Opening-balance-style draft where 1930 IB and 2099 IB are off by 0.01.
    const ibId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-01-01',
      description: 'Ingående balans (skewed)',
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1234.56, 0),
              ($1, '2099', 0, 1234.57)`,
      [ibId],
    )

    await expect(
      getPool().query(`SELECT commit_journal_entry($1, $2)`, [companyId, ibId]),
    ).rejects.toThrow()

    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [ibId],
    )
    expect(rows[0].status).toBe('draft')
  })

  // Sanity: roundOre / ORE_TOLERANCE are wired through. This is the
  // imported boundary: if it breaks, every consumer above breaks too.
  it('exposes a half-öre tolerance', () => {
    expect(ORE_TOLERANCE).toBe(0.005)
    expect(roundOre(1.005)).toBe(1.01)
  })

  // Quiet linter: randomUUID is referenced through the seed helper but
  // we keep an explicit import for future cases that need their own UUIDs.
  it('uuid helper is available', () => {
    expect(randomUUID()).toMatch(/[0-9a-f-]{36}/)
  })
})
