/**
 * pg-real test for get_onboarding_books_summary (migration 20260920215406,
 * balances from the ingående balans on since 20261112181800, read from
 * ledger_account_days since 20261113050911 once the company's summaries are
 * built; the line path stays for a company whose summaries are not).
 *
 * The RPC is the SQL side of loadBooksFindings (lib/onboarding/findings.ts):
 * latest-period revenue and result plus the 26xx and 1630 balances, summed
 * from the company's own entries. The sums used to be computed in JS
 * from lines downloaded through a PostgREST embed; this suite pins the same
 * semantics against real Postgres:
 *
 *   - the base set is posted AND reversed entries; drafts never count, and a
 *     reversed entry nets to zero together with its storno;
 *   - the period is the latest one with lines, matched on entry_date, so
 *     empty and future periods are skipped and boundary dates land in exactly
 *     one period;
 *   - revenue is class 3 and result classes 3 to 8, credit minus debit;
 *     26xx is credit minus debit, 1630 debit minus credit, independent of
 *     fiscal periods: all history for an account that never had an ingående
 *     balans, and from the latest one on for an account that has
 *     (account_ib_floor), so the years an IB restates count once;
 *   - the figures agree with get_trial_balance_aggregates on the same rows;
 *   - more than 1000 lines sum completely (the PostgREST page size the old
 *     path had to paginate around);
 *   - skattekonto_account / ledger_skattekonto (20261015030000): the
 *     company's skattekonto account and its balance, 2012 for an enskild
 *     firma that runs it there; ledger_1630 keeps reading 1630;
 *   - SECURITY INVOKER: a member sees what the superuser sees, a stranger
 *     gets an empty summary, anon cannot execute.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
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
  skattekonto_account: string
  ledger_skattekonto: number
}

const CALL_SQL = `SELECT public.get_onboarding_books_summary($1) AS payload`
const EMPTY: Summary = {
  period_name: null,
  revenue: null,
  result: null,
  vat_balance: 0,
  ledger_1630: 0,
  skattekonto_account: '1630',
  ledger_skattekonto: 0,
}

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
  /** Dated outside its own fiscal period, as only rows from before 20261024140200 can be. */
  misdated?: boolean
  /** 'opening_balance' for an ingående balans; a manual verifikat otherwise. */
  sourceType?: 'manual' | 'opening_balance'
  /** Write on this connection (the ledger summaries keep one slot per backend); a pooled one otherwise. */
  client?: PoolClient
}): Promise<string> {
  const id = randomUUID()
  const status = params.status ?? 'posted'
  const client = params.client ?? await getPool().connect()
  // Insert directly, bypassing commit_journal_entry's voucher sequencing:
  // fine for a read-side RPC that only aggregates lines.
  try {
    await client.query('BEGIN')
    if (params.misdated) {
      await client.query('ALTER TABLE public.journal_entries DISABLE TRIGGER zz_enforce_entry_date_in_fiscal_period')
    }
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Books summary RPC test', $8, $7)`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, ++voucherCounter, params.entryDate, status, params.sourceType ?? 'manual'],
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
    if (params.misdated) {
      // ALTER TABLE refuses a table with pending trigger events.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      await client.query('ALTER TABLE public.journal_entries ENABLE TRIGGER zz_enforce_entry_date_in_fiscal_period')
    }
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    if (!params.client) client.release()
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
      skattekonto_account: '1630',
      ledger_skattekonto: 300.5,
    })
  })

  it('reads the skattekonto on 2012 for an enskild firma that runs it there', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, entity_type, skattekonto_account)
       VALUES ($1, $2, 'enskild_firma', '2012')`,
      [userId, companyId],
    )
    const ctx = { userId, companyId }
    const fp = await period(ctx, 2026)
    // F-skatt paid from the bank onto the skattekonto, then the owner's tax drawn.
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-02-12',
      lines: [
        { account: '2012', debit: 3000, credit: 0 },
        { account: '1930', debit: 0, credit: 3000 },
      ],
    })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-02-12',
      lines: [
        { account: '2013', debit: 2500, credit: 0 },
        { account: '2012', debit: 0, credit: 2500 },
      ],
    })
    expect(await callRpc(ctx.companyId)).toMatchObject({
      ledger_1630: 0,
      skattekonto_account: '2012',
      ledger_skattekonto: 500,
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
      skattekonto_account: '1630',
      ledger_skattekonto: 0,
    })
  })

  it('counts balances, but no period figures, for entries dated outside every period', async () => {
    // Only a row from before 20261024140200 can be dated outside its year.
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp, entryDate: '2023-06-01', lines: sale(1000), misdated: true })
    expect(await callRpc(ctx.companyId)).toEqual({ ...EMPTY, vat_balance: 250 })
  })

  it('counts each account from its latest ingående balans on, so the years it restates count once', async () => {
    // Two imported years, the detail of both left in the ledger.
    //   2024: IB 1630 = 5 000, +2 000 paid in; VAT 2611 +3 000, IB 2611 = 1 000.
    //   2025: IB 1630 = 7 000 (5 000 + 2 000), -1 000 drawn; IB 2611 = 4 000, +500.
    // Every posting sums to 1630 = 13 000 and 26xx = 8 500. What stands on the
    // accounts is 6 000 and 4 500, the figures /skattekonto and the balance
    // sheet show. 2641 never had an IB: all its history counts.
    const ctx = await seedCompany()
    const fp2024 = await period(ctx, 2024)
    const fp2025 = await period(ctx, 2025)
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp2024, entryDate: '2024-01-01', sourceType: 'opening_balance',
      lines: [
        { account: '1630', debit: 5000, credit: 0 },
        { account: '2611', debit: 0, credit: 1000 },
        { account: '2099', debit: 0, credit: 4000 },
      ],
    })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp2024, entryDate: '2024-06-01',
      lines: [
        { account: '1630', debit: 2000, credit: 0 },
        { account: '1930', debit: 0, credit: 2000 },
      ],
    })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2024, entryDate: '2024-09-01', lines: sale(12000) })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp2025, entryDate: '2025-01-01', sourceType: 'opening_balance',
      lines: [
        { account: '1630', debit: 7000, credit: 0 },
        { account: '2611', debit: 0, credit: 4000 },
        { account: '2099', debit: 0, credit: 3000 },
      ],
    })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp2025, entryDate: '2025-03-01',
      lines: [
        { account: '1930', debit: 1000, credit: 0 },
        { account: '1630', debit: 0, credit: 1000 },
      ],
    })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2025, entryDate: '2025-04-01', lines: sale(2000) })
    // Input VAT on an account no ingående balans ever named, in both years.
    for (const [fp, date] of [[fp2024, '2024-10-01'], [fp2025, '2025-05-01']] as const) {
      await insertJournalEntry({
        ...ctx, fiscalPeriodId: fp, entryDate: date,
        lines: [
          { account: '5010', debit: 400, credit: 0 },
          { account: '2641', debit: 100, credit: 0 },
          { account: '1930', debit: 0, credit: 500 },
        ],
      })
    }

    const summary = await callRpc(ctx.companyId)
    expect(summary.ledger_1630).toBe(6000) // 7 000 - 1 000, not 13 000
    expect(summary.ledger_skattekonto).toBe(6000)
    expect(summary.vat_balance).toBe(4300) // 2611: 4 000 + 500; 2641: -100 - 100
    // The period figures never read an ingående balans: class 3 of 2025.
    expect(summary.period_name).toBe('2025')
    expect(summary.revenue).toBe(2000)
  })

  it('an opening_balance verifikat in mid-year floors nothing', async () => {
    // account_ib_floor reads a floor only on a fiscal year's first day: a
    // payment an import labelled opening_balance must not drop the months
    // before it.
    const ctx = await seedCompany()
    const fp = await period(ctx, 2026)
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-02-01',
      lines: [
        { account: '1630', debit: 800, credit: 0 },
        { account: '1930', debit: 0, credit: 800 },
      ],
    })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp, entryDate: '2026-06-15', sourceType: 'opening_balance',
      lines: [
        { account: '1630', debit: 200, credit: 0 },
        { account: '1930', debit: 0, credit: 200 },
      ],
    })
    expect((await callRpc(ctx.companyId)).ledger_1630).toBe(1000)
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
      skattekonto_account: '1630',
      ledger_skattekonto: 0,
    })
  })

  it('reads the same summary from the ledger summaries as from the lines', async () => {
    // A new company's summaries are built at once, so every case above runs
    // the summary path (20261113050911). This one also runs the line path, by
    // taking the company off ledger_account_days_companies, and compares:
    // IB years, a draft, a reversed sale with its storno and a VAT account no
    // ingående balans names.
    const ctx = await seedCompany()
    const fp2025 = await period(ctx, 2025)
    const fp2026 = await period(ctx, 2026)
    for (const [fp, date, ib1630, ib2650] of [[fp2025, '2025-01-01', 3000, 1200], [fp2026, '2026-01-01', 2500, 2200]] as const) {
      await insertJournalEntry({
        ...ctx, fiscalPeriodId: fp, entryDate: date, sourceType: 'opening_balance',
        lines: [
          { account: '1630', debit: ib1630, credit: 0 },
          { account: '2650', debit: 0, credit: ib2650 },
          { account: '2099', debit: 0, credit: ib1630 - ib2650 },
        ],
      })
    }
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2025, entryDate: '2025-05-02', lines: sale(4000) })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2026, entryDate: '2026-02-10', lines: sale(800) })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2026, entryDate: '2026-03-10', status: 'draft', lines: sale(5000) })
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2026, entryDate: '2026-04-01', status: 'reversed', lines: sale(300) })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp2026, entryDate: '2026-04-02',
      lines: sale(300).map((l) => ({ account: l.account, debit: l.credit, credit: l.debit })),
    })
    await insertJournalEntry({
      ...ctx, fiscalPeriodId: fp2026, entryDate: '2026-05-01',
      lines: [
        { account: '6110', debit: 400, credit: 0 },
        { account: '2641', debit: 100, credit: 0 },
        { account: '1930', debit: 0, credit: 500 },
      ],
    })

    const fromSummaries = await callRpc(ctx.companyId)
    expect(fromSummaries).toEqual({
      period_name: '2026',
      revenue: 800, // the reversed sale and its storno net to zero; the draft never counts
      result: 400,
      vat_balance: 3300, // 2650 from its 2026 IB: 2 200; 2611 all history: 1 200; 2641: -100
      ledger_1630: 2500, // from the 2026 IB on
      skattekonto_account: '1630',
      ledger_skattekonto: 2500,
    })

    const { rows: listed } = await getPool().query(`SELECT 1 FROM public.ledger_account_days_companies WHERE company_id = $1`, [ctx.companyId])
    expect(listed).toHaveLength(1)
    await getPool().query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [ctx.companyId])
    try {
      expect(await callRpc(ctx.companyId)).toEqual(fromSummaries)
    } finally {
      await getPool().query(`INSERT INTO public.ledger_account_days_companies (company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.companyId])
    }
  })

  it('a year emptied on another connection has no entries before the summaries are compacted', async () => {
    // ledger_account_days keeps one row per writer slot (the backend) until
    // compact_ledger_account_days folds them. A verifikat posted on one
    // connection and deleted on another, as reset_fiscal_year and
    // delete_last_voucher do, leaves a +1 and a -1 row for each of its days.
    // The year it emptied must not be taken for the latest year with entries.
    const ctx = await seedCompany()
    const fp2025 = await period(ctx, 2025)
    const fp2026 = await period(ctx, 2026)
    await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2025, entryDate: '2025-05-02', lines: sale(4000) })

    const poster = await getPool().connect()
    const remover = await getPool().connect()
    try {
      const id = await insertJournalEntry({ ...ctx, fiscalPeriodId: fp2026, entryDate: '2026-02-10', lines: sale(800), client: poster })
      await remover.query('BEGIN')
      await remover.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await remover.query('DELETE FROM public.journal_entries WHERE id = $1', [id])
      await remover.query('COMMIT')
    } catch (error) {
      await remover.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      poster.release()
      remover.release()
    }

    // Two connections, two slots: the removal is a negative row beside the
    // positive one, not a change to it.
    const { rows: split } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.ledger_account_days WHERE company_id = $1 AND line_count < 0`,
      [ctx.companyId],
    )
    expect(split[0].n).toBeGreaterThan(0)

    const expected: Summary = {
      period_name: '2025',
      revenue: 4000,
      result: 4000,
      vat_balance: 1000, // 2611: 1 000 from 2025; the 2026 sale's 200 came and went
      ledger_1630: 0,
      skattekonto_account: '1630',
      ledger_skattekonto: 0,
    }
    expect(await callRpc(ctx.companyId)).toEqual(expected)
    await getPool().query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [ctx.companyId])
    try {
      expect(await callRpc(ctx.companyId)).toEqual(expected)
    } finally {
      await getPool().query(`INSERT INTO public.ledger_account_days_companies (company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.companyId])
    }
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
