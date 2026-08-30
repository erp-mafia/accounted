/**
 * The VAT ruta drill-down must return exactly the lines the filed figure sums.
 *
 * `get_vat_declaration_totals` drops four classes of entry before summing:
 * posted closing entries, source_type 'vat_settlement', the two kontantmetod
 * year-end reversals, and any entry shaped like a momsredovisning (a line on a
 * ruta account AND a line on 2650/1650). `get_vat_ruta_source_lines` filtered
 * on company, status and date only, so expanding a ruta listed verifikat that
 * were not in the number it claims to explain. 322 posted/reversed entries
 * across 214 companies sat in those classes on production (2026-08-28).
 *
 * A momsdeklaration is räkenskapsinformation (BFL 5 kap.) and this drill-down
 * is what substantiates a filed figure, so the headline test here is a single
 * equality: for every account, the drill-down's sum equals the figure's total.
 * It holds for the whole account set at once, so a future edit to one function
 * and not the other fails here rather than silently misreporting.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'

// Mirrors the TS call site: a representative slice of ACCOUNT_RUTA. The full
// list is a parameter, never baked into the SQL.
const RUTA_ACCOUNTS = ['2611', '2641', '2645', '3001']
const NET_ACCOUNTS = ['2650', '1650']
const ALL_ACCOUNTS = [...RUTA_ACCOUNTS, ...NET_ACCOUNTS]
const BALANCING_ACCOUNT = '2999'

interface DrillLine {
  line_id: string
  journal_entry_id: string
  voucher_number: number
  entry_date: string
  description: string
  debit_amount: string | number
  credit_amount: string | number
}

async function figureTotals(companyId: string) {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload`,
    [companyId, '2026-01-01', '2026-12-31', ALL_ACCOUNTS, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  const payload = rows[0].payload as {
    totals: Array<{ account_number: string; debit: number; credit: number }>
  }
  return new Map(payload.totals.map((t) => [t.account_number, t]))
}

async function drillDown(companyId: string, accounts: string[]): Promise<DrillLine[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM public.get_vat_ruta_source_lines(
       $1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)`,
    [companyId, '2026-01-01', '2026-12-31', accounts, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  return rows as DrillLine[]
}

function sumOf(lines: DrillLine[]) {
  return lines.reduce(
    (acc, l) => ({
      debit: acc.debit + Number(l.debit_amount ?? 0),
      credit: acc.credit + Number(l.credit_amount ?? 0),
    }),
    { debit: 0, credit: 0 },
  )
}

async function insertEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  sourceType?: string
  description?: string
  lines: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  return insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
    entryDate: '2026-03-15',
    description: params.description ?? 'drilldown test',
    sourceType: params.sourceType ?? 'manual',
    lines: params.lines.map((l) => ({
      accountNumber: l.account,
      debitAmount: l.debit,
      creditAmount: l.credit,
    })),
  })
}

describe('VAT ruta drill-down reconciles with the declaration figure', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string
  let plainEntryId: string

  beforeAll(async () => {
    userId = await insertAuthUser()
    companyId = await insertCompany({ createdBy: userId })
    fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    // 1. A plain sale. Must appear in BOTH the figure and the drill-down.
    plainEntryId = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
      description: 'Vanlig försäljning',
      lines: [
        { account: '3001', debit: 0, credit: 800 },
        { account: '2611', debit: 0, credit: 200 },
        { account: BALANCING_ACCOUNT, debit: 1000, credit: 0 },
      ],
    })

    // 2. A tagged momsredovisning. Excluded from the figure.
    await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2,
      sourceType: 'vat_settlement', description: 'Momsredovisning',
      lines: [
        { account: '2611', debit: 200, credit: 0 },
        { account: '2650', debit: 0, credit: 200 },
      ],
    })

    // 3. Settlement SHAPE without the tag: a ruta account plus 2650.
    await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 3,
      sourceType: 'manual', description: 'Otaggad momsredovisning',
      lines: [
        { account: '2641', debit: 0, credit: 125 },
        { account: '2650', debit: 125, credit: 0 },
      ],
    })

    // 4. The kontantmetod year-end reversal, excluded by description.
    await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 4,
      sourceType: 'year_end',
      description: 'Vändning kundfordringar bokslut (kontantmetoden)',
      lines: [
        { account: '2611', debit: 50, credit: 0 },
        { account: BALANCING_ACCOUNT, debit: 0, credit: 50 },
      ],
    })

    // 5. An opening balance. Deliberately NOT excluded: the figure exempts
    //    opening_balance from `shaped`, which keeps its lines in the totals.
    //    Dropping it here would break the equality in the other direction.
    await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 5,
      sourceType: 'opening_balance', description: 'Ingående balans',
      lines: [
        { account: '2641', debit: 75, credit: 0 },
        { account: BALANCING_ACCOUNT, debit: 0, credit: 75 },
      ],
    })

    // 6. A posted closing entry, excluded once the period points at it.
    const closingId = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 6,
      sourceType: 'year_end', description: 'Bokslutsverifikat',
      lines: [
        { account: '2611', debit: 0, credit: 40 },
        { account: BALANCING_ACCOUNT, debit: 40, credit: 0 },
      ],
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
      [closingId, fiscalPeriodId],
    )
  }, 60_000)

  it('sums identically to the figure, for every account', async () => {
    // The headline assertion. Any entry the figure drops and the drill-down
    // keeps (or vice versa) shows up here as a mismatched account.
    const totals = await figureTotals(companyId)
    const mismatches: string[] = []

    for (const account of ALL_ACCOUNTS) {
      const lines = await drillDown(companyId, [account])
      const drilled = sumOf(lines)
      const figure = totals.get(account) ?? { debit: 0, credit: 0 }
      if (
        Math.round(drilled.debit * 100) !== Math.round(Number(figure.debit) * 100) ||
        Math.round(drilled.credit * 100) !== Math.round(Number(figure.credit) * 100)
      ) {
        mismatches.push(
          `${account}: drill-down ${drilled.debit}/${drilled.credit} vs figure ${figure.debit}/${figure.credit}`,
        )
      }
    }

    expect(mismatches).toEqual([])
  }, 60_000)

  it('still returns the ordinary sale it is meant to explain', async () => {
    // Guards the other direction: a filter that excluded everything would
    // satisfy the equality above trivially if the figure were empty too.
    const lines = await drillDown(companyId, ['2611'])
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.map((l) => l.journal_entry_id)).toContain(plainEntryId)
    expect(sumOf(lines).credit).toBe(200)
  }, 30_000)

  it('excludes tagged settlements, shaped settlements, kontantmetod reversals and closing entries', async () => {
    const descriptions = (await drillDown(companyId, ALL_ACCOUNTS)).map((l) => l.description)
    expect(descriptions).not.toContain('Momsredovisning')
    expect(descriptions).not.toContain('Otaggad momsredovisning')
    expect(descriptions).not.toContain('Vändning kundfordringar bokslut (kontantmetoden)')
    expect(descriptions).not.toContain('Bokslutsverifikat')
  }, 30_000)

  it('keeps opening-balance lines, which the figure also counts', async () => {
    // The subtle one. `shaped` exempts opening_balance, so its 26xx lines stay
    // in the totals; excluding them from the drill-down would be a new bug in
    // the opposite direction.
    const lines = await drillDown(companyId, ['2641'])
    expect(lines.map((l) => l.description)).toContain('Ingående balans')
  }, 30_000)

  it('grants EXECUTE to authenticated and service_role but not anon', async () => {
    // 20260828172003 DROPped the 9-arg overload and CREATEd this 11-arg one
    // without restating the REVOKE/GRANT from 20260721103000; DROP FUNCTION
    // discards the ACL, so the new signature fell back to EXECUTE for PUBLIC
    // (which includes anon). 20260829090500 restores least privilege. The
    // overload count pins the other half of that migration: exactly one
    // signature, so PostgREST never has to choose.
    const { rows } = await getPool().query<{
      anon_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
      overloads: string
    }>(
      `SELECT has_function_privilege('anon', 'public.get_vat_ruta_source_lines(uuid,date,date,text[],text[],text[],date,integer,uuid,uuid,integer)', 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', 'public.get_vat_ruta_source_lines(uuid,date,date,text[],text[],text[],date,integer,uuid,uuid,integer)', 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', 'public.get_vat_ruta_source_lines(uuid,date,date,text[],text[],text[],date,integer,uuid,uuid,integer)', 'EXECUTE') AS service_role_can,
              (SELECT count(*) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'get_vat_ruta_source_lines')::text AS overloads`,
    )
    expect(rows[0]!.anon_can).toBe(false)
    expect(rows[0]!.authenticated_can).toBe(true)
    expect(rows[0]!.service_role_can).toBe(true)
    expect(rows[0]!.overloads).toBe('1')
  }, 30_000)
})
