/**
 * The second momsredovisning shape: VAT moved straight against the skattekonto
 * (migration 20260920182259, issue #2805).
 *
 * Both VAT functions drop an untagged verifikat that is a PURE movement
 * between 26xx declaration accounts and 1630 (3740 tolerated), with no
 * 2650/1650 line. The existing 2650/1650 shape is untouched. The case behind
 * the issue, anonymised: Skatteverket's omprövning of an earlier quarter
 * credited the skattekonto and was booked X = 1630 D / 2610 K; the same day
 * Y = 2610 D / 1650 K reclassified the counter-entry. The ledger nets to
 * 1630 D / 1650 K, which touches no ruta, but the report dropped Y by shape and
 * counted X, overstating ruta 10 by the full amount.
 *
 * Cases, one company each so no fixture can mask another:
 *   (a) X is excluded and listed in settlement_shaped_entries
 *   (b) Y is still excluded (unchanged behaviour)
 *   (c) X and Y together leave ruta 10 at the period's real sales VAT
 *   (d) 1630 D / 3980 K, a bidrag received on the skattekonto, still counts
 *   (e) 5410 D / 2641 D / 1630 K, a business verifikat, still counts
 *   (f) a classic settlement and one with a small cost line are still excluded
 *   (g) get_vat_ruta_source_lines gives the same verdict as the figure, a to f
 *
 * The account lists are the REAL ones the app passes (VAT_ACCOUNTS and
 * VAT_SETTLEMENT_NET_ACCOUNTS), not a slice: which p_ruta_accounts are 26xx,
 * and that 3980 is on the list at all, is exactly what (a) and (d) turn on.
 */
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import {
  VAT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
} from '@/lib/reports/vat-declaration'

const RUTA_ACCOUNTS = VAT_ACCOUNTS
const NET_ACCOUNTS = VAT_SETTLEMENT_NET_ACCOUNTS
// Exactly what fetchVatAccountTotals passes for a company with no accounts of
// its own on ruta 05.
const ALL_ACCOUNTS = [...RUTA_ACCOUNTS, ...NET_ACCOUNTS]
const START = '2026-01-01'
const END = '2026-12-31'

interface FigurePayload {
  totals: Array<{ account_number: string; debit: number; credit: number }>
  settlement_shaped_entries: Array<{
    id: string
    status: string
    entry_date: string
    source_type: string | null
    voucher_series: string | null
    voucher_number: number | null
  }>
  source_type_counts: Record<string, number>
}

interface DrillLine {
  journal_entry_id: string
  debit_amount: string | number
  credit_amount: string | number
}

type Line = [account: string, debit: number, credit: number]

async function figure(companyId: string): Promise<FigurePayload> {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload`,
    [companyId, START, END, ALL_ACCOUNTS, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  return rows[0].payload as FigurePayload
}

async function drillDown(companyId: string, accounts: string[]): Promise<DrillLine[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM public.get_vat_ruta_source_lines(
       $1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)`,
    [companyId, START, END, accounts, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  return rows as DrillLine[]
}

function balanceOf(payload: FigurePayload, account: string) {
  const t = payload.totals.find((row) => row.account_number === account)
  return { debit: Number(t?.debit ?? 0), credit: Number(t?.credit ?? 0) }
}

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  let voucherNumber = 0
  const post = (lines: Line[], sourceType = 'manual', description = 'skattekonto shape test') =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: ++voucherNumber,
      entryDate: '2026-03-15',
      description,
      sourceType,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({
        accountNumber,
        debitAmount,
        creditAmount,
      })),
    })
  return { companyId, post }
}

// The period's real activity: a 25 % sale (ruta 05 / ruta 10) and a purchase
// with input VAT (ruta 48).
const SALE: Line[] = [['1510', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]]
const PURCHASE: Line[] = [['5410', 400, 0], ['2641', 100, 0], ['2440', 0, 500]]
const X: Line[] = [['1630', 86217, 0], ['2610', 0, 86217]]
const Y: Line[] = [['2610', 86217, 0], ['1650', 0, 86217]]

/**
 * (g) for one company: every account the figure can return sums to the same
 * debit and credit through the drill-down, and no excluded verifikat shows up
 * as a drill-down line.
 */
async function expectDrillDownAgrees(companyId: string, excludedIds: string[]) {
  const payload = await figure(companyId)
  const mismatches: string[] = []
  for (const account of ALL_ACCOUNTS) {
    const lines = await drillDown(companyId, [account])
    const debit = lines.reduce((sum, l) => sum + Number(l.debit_amount ?? 0), 0)
    const credit = lines.reduce((sum, l) => sum + Number(l.credit_amount ?? 0), 0)
    const expected = balanceOf(payload, account)
    if (
      Math.round(debit * 100) !== Math.round(expected.debit * 100) ||
      Math.round(credit * 100) !== Math.round(expected.credit * 100)
    ) {
      mismatches.push(
        `${account}: drill-down ${debit}/${credit} vs figure ${expected.debit}/${expected.credit}`,
      )
    }
  }
  expect(mismatches).toEqual([])

  const drilledEntryIds = new Set(
    (await drillDown(companyId, ALL_ACCOUNTS)).map((l) => l.journal_entry_id),
  )
  for (const id of excludedIds) expect(drilledEntryIds.has(id)).toBe(false)
}

describe('VAT functions: verifikat booked straight against the skattekonto', () => {
  it('(a) excludes 1630 D / 2610 K and lists it as settlement-shaped', async () => {
    const { companyId, post } = await seed()
    await post(SALE, 'invoice_created')
    const xId = await post(X)

    const payload = await figure(companyId)
    // Only the sale is left on ruta 10's accounts.
    expect(balanceOf(payload, '2610')).toEqual({ debit: 0, credit: 0 })
    expect(balanceOf(payload, '2611')).toEqual({ debit: 0, credit: 250 })
    expect(payload.settlement_shaped_entries.map((e) => e.id)).toEqual([xId])
    expect(payload.settlement_shaped_entries[0]).toMatchObject({
      status: 'posted',
      source_type: 'manual',
      voucher_series: 'A',
      voucher_number: 2,
    })
    // source_type_counts still counts every posted entry in the period.
    expect(payload.source_type_counts).toEqual({ invoice_created: 1, manual: 1 })

    await expectDrillDownAgrees(companyId, [xId])
  }, 60_000)

  it('(a) also covers VAT settled or refunded without 2650, and öresutjämning', async () => {
    const { companyId, post } = await seed()
    await post(SALE, 'invoice_created')
    await post(PURCHASE, 'supplier_invoice_registered')
    const settledId = await post([['2611', 250, 0], ['1630', 0, 250]], 'import')
    const refundedId = await post([['1630', 100, 0], ['2641', 0, 100]], 'import')
    const roundedId = await post([
      ['2611', 249.6, 0], ['2641', 0, 99.2], ['3740', 0, 0.4], ['1630', 0, 150],
    ])

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2611')).toEqual({ debit: 0, credit: 250 })
    expect(balanceOf(payload, '2641')).toEqual({ debit: 100, credit: 0 })
    expect(payload.settlement_shaped_entries.map((e) => e.id).sort()).toEqual(
      [settledId, refundedId, roundedId].sort(),
    )

    await expectDrillDownAgrees(companyId, [settledId, refundedId, roundedId])
  }, 60_000)

  it('(b) still excludes 2610 D / 1650 K, exactly as before', async () => {
    const { companyId, post } = await seed()
    await post(SALE, 'invoice_created')
    const yId = await post(Y)

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2610')).toEqual({ debit: 0, credit: 0 })
    expect(balanceOf(payload, '1650')).toEqual({ debit: 0, credit: 0 })
    expect(payload.settlement_shaped_entries.map((e) => e.id)).toEqual([yId])

    await expectDrillDownAgrees(companyId, [yId])
  }, 60_000)

  it('(c) X and Y together leave ruta 10 at the real sales VAT', async () => {
    const { companyId, post } = await seed()
    await post(SALE, 'invoice_created')
    await post(PURCHASE, 'supplier_invoice_registered')
    const xId = await post(X)
    const yId = await post(Y)

    const payload = await figure(companyId)
    // Ruta 10 reads 2610-2618 on the credit side. Before this migration X was
    // counted and Y dropped: 2610 carried a credit of 86 217 and ruta 10 was
    // 86 467 against a real 250.
    expect(balanceOf(payload, '2610')).toEqual({ debit: 0, credit: 0 })
    expect(balanceOf(payload, '2611')).toEqual({ debit: 0, credit: 250 })
    expect(balanceOf(payload, '2641')).toEqual({ debit: 100, credit: 0 })
    expect(balanceOf(payload, '3001')).toEqual({ debit: 0, credit: 1000 })
    expect(payload.settlement_shaped_entries.map((e) => e.id).sort()).toEqual([xId, yId].sort())
    // Disjoint shapes: neither verifikat is listed twice.
    expect(payload.settlement_shaped_entries).toHaveLength(2)

    await expectDrillDownAgrees(companyId, [xId, yId])
  }, 60_000)

  it('(d) still counts a bidrag received on the skattekonto: 1630 D / 3980 K', async () => {
    const { companyId, post } = await seed()
    const bidragId = await post([['1630', 25136, 0], ['3980', 0, 25136]])

    const payload = await figure(companyId)
    // 3980 is a declaration account (ruta 42) but not a 26xx account.
    expect(balanceOf(payload, '3980')).toEqual({ debit: 0, credit: 25136 })
    expect(payload.settlement_shaped_entries).toEqual([])

    const lines = await drillDown(companyId, ['3980'])
    expect(lines.map((l) => l.journal_entry_id)).toEqual([bidragId])
    await expectDrillDownAgrees(companyId, [])
  }, 60_000)

  it('(e) still counts a business verifikat paid from the skattekonto: 5410 D / 2641 D / 1630 K', async () => {
    const { companyId, post } = await seed()
    const businessId = await post([['5410', 400, 0], ['2641', 100, 0], ['1630', 0, 500]])

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2641')).toEqual({ debit: 100, credit: 0 })
    expect(payload.settlement_shaped_entries).toEqual([])

    const lines = await drillDown(companyId, ['2641'])
    expect(lines.map((l) => l.journal_entry_id)).toEqual([businessId])
    await expectDrillDownAgrees(companyId, [])
  }, 60_000)

  it('(f) still excludes a classic settlement and one carrying a small cost line', async () => {
    const { companyId, post } = await seed()
    await post(SALE, 'invoice_created')
    await post(PURCHASE, 'supplier_invoice_registered')
    const classicId = await post(
      [['2611', 250, 0], ['2641', 0, 100], ['2650', 0, 150]], 'import',
    )
    // An imported monthly settlement that also books a small cost: NOT pure,
    // and it must stay excluded. This is the shape that made every arithmetic
    // narrowing of the 2650/1650 rule unsafe.
    const withCostId = await post(
      [['2611', 250, 0], ['2641', 0, 100], ['6050', 40, 0], ['2650', 0, 190]], 'import',
    )

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2611')).toEqual({ debit: 0, credit: 250 })
    expect(balanceOf(payload, '2641')).toEqual({ debit: 100, credit: 0 })
    expect(balanceOf(payload, '2650')).toEqual({ debit: 0, credit: 0 })
    expect(payload.settlement_shaped_entries.map((e) => e.id).sort()).toEqual(
      [classicId, withCostId].sort(),
    )

    await expectDrillDownAgrees(companyId, [classicId, withCostId])
  }, 60_000)

  it('keeps the exemptions: opening balances count, and 2650 paid from 1630 is not shaped', async () => {
    const { companyId, post } = await seed()
    // A carried-in VAT balance parked against the skattekonto in an opening
    // balance is unsettled VAT for the next declaration, as under shape 1.
    const openingId = await post([['1630', 300, 0], ['2611', 0, 300]], 'opening_balance')
    // Paying the declared VAT from the skattekonto touches no declaration account.
    await post([['2650', 150, 0], ['1630', 0, 150]])

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2611')).toEqual({ debit: 0, credit: 300 })
    expect(balanceOf(payload, '2650')).toEqual({ debit: 150, credit: 0 })
    expect(payload.settlement_shaped_entries).toEqual([])

    const lines = await drillDown(companyId, ['2611'])
    expect(lines.map((l) => l.journal_entry_id)).toEqual([openingId])
    await expectDrillDownAgrees(companyId, [])
  }, 60_000)

  it('keeps both signatures and ACLs as they were', async () => {
    const totalsSig = 'public.get_vat_declaration_totals(uuid,date,date,text[],text[],text[])'
    const drillSig =
      'public.get_vat_ruta_source_lines(uuid,date,date,text[],text[],text[],date,integer,uuid,uuid,integer)'
    const { rows } = await getPool().query<{
      totals_anon: boolean
      totals_authenticated: boolean
      totals_service_role: boolean
      drill_anon: boolean
      drill_authenticated: boolean
      drill_service_role: boolean
      overloads: string
    }>(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS totals_anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS totals_authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') AS totals_service_role,
              has_function_privilege('anon', $2, 'EXECUTE') AS drill_anon,
              has_function_privilege('authenticated', $2, 'EXECUTE') AS drill_authenticated,
              has_function_privilege('service_role', $2, 'EXECUTE') AS drill_service_role,
              (SELECT count(*) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN ('get_vat_declaration_totals', 'get_vat_ruta_source_lines'))::text AS overloads`,
      [totalsSig, drillSig],
    )
    expect(rows[0]).toEqual({
      totals_anon: false,
      totals_authenticated: true,
      totals_service_role: true,
      drill_anon: false,
      drill_authenticated: true,
      drill_service_role: true,
      // One signature each: no parameter was added, so the app deployed before
      // the migration keeps resolving the same function.
      overloads: '2',
    })
  }, 30_000)
})
