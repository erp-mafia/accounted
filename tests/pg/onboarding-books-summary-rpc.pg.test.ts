/**
 * pg-real test for get_onboarding_books_summary (migration 20260920215406).
 *
 * The RPC is the SQL side of loadBooksFindings (lib/onboarding/findings.ts):
 * latest-period revenue and result plus the all-time 26xx and 1630 balances,
 * summed from the company's own entries. The sums used to be computed in JS
 * from lines downloaded through a PostgREST embed; this suite pins the same
 * semantics against real Postgres:
 *
 *   - the base set is posted AND reversed entries; drafts never count, and a
 *     reversed entry nets to zero together with its storno;
 *   - the period is the latest one with lines, matched on entry_date, so
 *     empty and future periods are skipped and boundary dates land in exactly
 *     one period;
 *   - revenue is class 3 and result classes 3 to 8, credit minus debit;
 *     26xx is credit minus debit, 1630 debit minus credit, both across all
 *     time and independent of fiscal periods;
 *   - the figures agree with get_trial_balance_aggregates on the same rows;
 *   - more than 1000 lines sum completely (the PostgREST page size the old
 *     path had to paginate around);
 *   - SECURITY INVOKER: a member sees what the superuser sees, a stranger
 *     gets an empty summary, anon cannot execute.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from './fixtures'

interface Summary {
  period_name: string | null
  revenue: number | null
  result: number | null
  vat_balance: number
  ledger_1630: number
}

const CALL_SQL = `SELECT public.get_onboarding_books_summary($1) AS payload`
const EMPTY: Summary = { period_name: null, revenue: null, result: null, vat_balance: 0, ledger_1630: 0 }

async function callRpc(companyId: string): Promise<Summary> {
  const { rows } = await getPool().query<{ payload: Summary }>(CALL_SQL, [companyId])
  return rows[0].payload
}

interface Ctx {
  userId: string
  companyId: string
}

let voucherCounter = 0

async function insertJournalEntry(params: Ctx & {
  fiscalPeriodId: string
  status?: 'draft' | 'posted' | 'reversed'
  entryDate: string
  lines: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  const id = randomUUID()
  const status = params.status ?? 'posted'
  const client = await getPool().connect()
  // Insert directly, bypassing commit_journal_entry's voucher sequencing:
  // fine for a read-side RPC that only aggregates lines.
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Books summary RPC test', 'manual', $7)`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, ++voucherCounter, params.entryDate, status],
    )
    for (const line of params.lines) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4)`,
        [id, line.account, line.debit, line.credit],
      )
    }
    if (status === 'posted') {
      await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    }
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function seedCompany(): Promise<Ctx> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

const period = (ctx: Ctx, year: number) =>
  insertFiscalPeriod({
    ...ctx,
    name: String(year),
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
  })

/** A 1000 + 25% VAT sale, paid to the bank. */
const sale = (net: number) => [
  { account: '1930', debit: net * 1.25, credit: 0 },
  { account: '3001', debit: 0, credit: net },
  { account: '2611', debit: 0, credit: net * 0.25 },
]

describe('get_onboarding_books_summary', () => {
  it('returns an empty summary for a company without entries', async () => {
    const ctx = await seedCompany()
    await period(ctx, 2026)
    expect(await callRpc(ctx.companyId)).toEqual(EMPTY)
  })

  it('returns an empty summary for a company without fiscal periods', async () => {
    const ctx = await seedCompany()
    expect(await callRpc(ctx.companyId)).toEqual(EMPTY)
  })

  it('pins the signs: revenue, result, VAT owed and the skattekonto asset', async () => {
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, entryDate: '2026-03-01', lines: sale(1000) })
    // Credit note: revenue debited.
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-03-05',
      lines: [
        { account: '3001', debit: 200, credit: 0 },
        { account: '2611', debit: 50, credit: 0 },
        { account: '1930', debit: 0, credit: 250 },
      ],
    })
    // Cost with input VAT.
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-04-01',
      lines: [
        { account: '5010', debit: 400, credit: 0 },
        { account: '2641', debit: 100, credit: 0 },
        { account: '1930', debit: 0, credit: 500 },
      ],
    })
    // Interest income (class 8) and a tax payment into the skattekonto.
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-05-01',
      lines: [
        { account: '1630', debit: 300.5, credit: 0 },
        { account: '8310', debit: 0, credit: 0.5 },
        { account: '1930', debit: 0, credit: 300 },
      ],
    })
    expect(await callRpc(ctx.companyId)).toEqual({
      period_name: '2026',
      revenue: 800,
      result: 400.5, // 800 - 400 + 0.5
      vat_balance: 100, // 250 - 50 - 100
      ledger_1630: 300.5,
    })
  })

  it('ignores drafts and nets a reversed entry against its storno', async () => {
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, entryDate: '2026-02-01', lines: sale(1000) })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, status: 'draft', entryDate: '2026-02-02', lines: sale(5000) })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, status: 'reversed', entryDate: '2026-02-03', lines: sale(700) })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-02-04',
      lines: [
        { account: '1930', debit: 0, credit: 875 },
        { account: '3001', debit: 700, credit: 0 },
        { account: '2611', debit: 175, credit: 0 },
      ],
    })
    expect(await callRpc(ctx.companyId)).toMatchObject({ revenue: 1000, result: 1000, vat_balance: 250 })
  })

  it('a company with only drafts has no period figures', async () => {
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, status: 'draft', entryDate: '2026-02-02', lines: sale(5000) })
    expect(await callRpc(ctx.companyId)).toEqual(EMPTY)
  })

  it('picks the latest period WITH entries and splits boundary dates by entry_date', async () => {
    const ctx = await seedCompany()
    const fp2024 = await period(ctx, 2024)
    const fp2025 = await period(ctx, 2025)
    await period(ctx, 2026) // empty current year
    await period(ctx, 2027) // future year
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2024, entryDate: '2024-12-31', lines: sale(100) })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2025, entryDate: '2025-01-01', lines: sale(2000) })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2025, entryDate: '2025-12-31', lines: sale(3000) })
    expect(await callRpc(ctx.companyId)).toEqual({
      period_name: '2025',
      revenue: 5000, // both boundary days of 2025, not 2024-12-31
      result: 5000,
      vat_balance: 1275, // all three years: balances ignore periods
      ledger_1630: 0,
    })
  })

  it('counts balances, but no period figures, for entries dated outside every period', async () => {
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, entryDate: '2023-06-01', lines: sale(1000) })
    expect(await callRpc(ctx.companyId)).toEqual({ ...EMPTY, vat_balance: 250 })
  })

  it('agrees with get_trial_balance_aggregates on the same rows', async () => {
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    const sales = [
      { gross: 1234.56, net: 1234.55, vat: 0.01 },
      { gross: 99.99, net: 99.98, vat: 0.01 },
      { gross: 10, net: 9.99, vat: 0.01 },
      { gross: 45000, net: 44999.99, vat: 0.01 },
    ]
    for (const [i, s] of sales.entries()) {
      await insertJournalEntry({
        ...ctx, fiscalPeriodId: fp, entryDate: `2026-0${i + 1}-15`,
        lines: [
          { account: '1930', debit: s.gross, credit: 0 },
          { account: '3001', debit: 0, credit: s.net },
          { account: '2611', debit: 0, credit: s.vat },
        ],
      })
    }
    const { rows } = await getPool().query<{ revenue: string; vat: string }>(
      `SELECT sum((r->>'credit')::numeric - (r->>'debit')::numeric)
                FILTER (WHERE r->>'account_number' LIKE '3%') AS revenue,
              sum((r->>'credit')::numeric - (r->>'debit')::numeric)
                FILTER (WHERE r->>'account_number' LIKE '26%') AS vat
       FROM jsonb_array_elements(
         public.get_trial_balance_aggregates($1, $2, 'include', NULL, NULL, NULL, NULL)
       ) r`,
      [ctx.companyId, fp],
    )
    const summary = await callRpc(ctx.companyId)
    expect(summary.revenue).toBe(Number(rows[0].revenue))
    expect(summary.vat_balance).toBe(Number(rows[0].vat))
    expect(summary.revenue).toBe(46344.51)
    expect(summary.vat_balance).toBe(0.04)
  })

  it('sums every line of a ledger larger than one PostgREST page', async () => {
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    // 1500 entries, 4500 lines, inserted set-wise.
    await getPool().query(
      `WITH e AS (
         INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         SELECT gen_random_uuid(), $1, $2, $3, 100000 + g, 'B',
                DATE '2026-01-01' + (g % 365), 'Bulk', 'manual', 'posted'
         FROM generate_series(1, 1500) g
         RETURNING id
       )
       INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT e.id, l.account, l.debit, l.credit
       FROM e CROSS JOIN (VALUES ('1930', 12.5, 0), ('3001', 0, 10.01), ('2611', 0, 2.49)) AS l(account, debit, credit)`,
      [ctx.userId, ctx.companyId, fp],
    )
    expect(await callRpc(ctx.companyId)).toEqual({
      period_name: '2026',
      revenue: 15015,
      result: 15015,
      vat_balance: 3735,
      ledger_1630: 0,
    })
  })

  it('SECURITY INVOKER: member sees the books, a stranger an empty summary, anon nothing', async () => {
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, entryDate: '2026-03-01', lines: sale(1000) })
    // The stranger has books of their own: they must not leak in either.
    const other = await seedCompany()
    const otherFp = await period(other, 2026)
    await insertJournalEntry({ ...other, fiscalPeriodId: otherFp, entryDate: '2026-03-01', lines: sale(9999) })

    const asSuperuser = await callRpc(ctx.companyId)
    const asMember = await withUserContext(ctx.userId, async (client) => {
      const { rows } = await client.query<{ payload: Summary }>(CALL_SQL, [ctx.companyId])
      return rows[0].payload
    })
    const asStranger = await withUserContext(other.userId, async (client) => {
      const { rows } = await client.query<{ payload: Summary }>(CALL_SQL, [ctx.companyId])
      return rows[0].payload
    })

    expect(asMember).toEqual(asSuperuser)
    expect(asMember.revenue).toBe(1000)
    expect(asStranger).toEqual(EMPTY)

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query(CALL_SQL, [ctx.companyId])).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
