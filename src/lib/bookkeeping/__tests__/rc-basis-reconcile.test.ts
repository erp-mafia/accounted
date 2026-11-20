/**
 * crm#1096: one rule for "does this cost line already report its own
 * reverse-charge basis, and at which sats", the declaration's
 * (costAccountRcBasisRate with the chart's momskod and momssats), applied by
 * every bank-categorization door on the account the cost line finally lands
 * on. A cost account the company gave a reverse-charge momskod (4056 as EU
 * goods, 6540 as EU services) reports ruta 20-24 itself; a 45xx / 4598 pair on
 * top of it put the purchase in the declaration twice, and fiktiv moms at
 * another sats than the account's broke the per-rate identity the filing gate
 * checks.
 */
import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import { reconcileRcBasisWithChart, reconcileRcBasisWithCostLines } from '../rc-basis-reconcile'
import { chartVatTreatmentsLoader, fetchChartVatTreatments } from '../chart-vat-treatments'
import { buildMappingResultFromCategory } from '../category-mapping'
import { buildTransactionEntryLines } from '../transaction-entries'
import { chartVatTreatmentsOf } from '../vat-entries'
import { rutorFromTotals } from '@/lib/reports/vat-declaration'
import { runVatDeclarationChecks } from '@/lib/reports/vat-declaration-checks'
import { rcBasisTotalsByRate, withRcBasisGapFindings } from '@/lib/reports/vat-filing-gate'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { roundOre } from '@/lib/money'
import type { MappingResult, Transaction } from '@/types'

const purchase = (amount = -1000): Transaction =>
  makeTransaction({ amount, amount_sek: amount, currency: 'SEK', exchange_rate: 1, description: 'SAAS EU' })

/** What a category booking of a reverse-charge purchase carries before the door settles it. */
const rcCategory = (costAccount: string, amount = -1000): MappingResult => {
  const result = buildMappingResultFromCategory('expense_software', purchase(amount), true, 'aktiebolag', 'reverse_charge')
  return { ...result, debit_account: costAccount }
}

const accounts = (result: MappingResult) => result.vat_lines.map((l) => l.account_number)
const shape = (result: MappingResult) =>
  result.vat_lines.filter((l) => !l.business_line).map((l) => [l.account_number, l.debit_amount, l.credit_amount])

type ChartRow = { account_number: string; default_vat_treatment: string; default_vat_rate?: number | null }

/** The company's momskoder: account -> momskod, or [momskod, momssats]. */
function chartOf(codes: Record<string, string | [string, number]>): ChartRow[] {
  return Object.entries(codes).map(([account_number, code]) => ({
    account_number,
    default_vat_treatment: Array.isArray(code) ? code[0] : code,
    default_vat_rate: Array.isArray(code) ? code[1] : null,
  }))
}

/**
 * The momsdeklaration and its filing gate over one verifikat, with the chart
 * read by the declaration's own loader (fetchDynamicVatAccounts): the rutor,
 * the aggregate checks, and the per-rate evidence the per-verifikat finding
 * is tiered by.
 */
async function declare(tx: Transaction, result: MappingResult, rows: ChartRow[]) {
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const line of buildTransactionEntryLines(tx, result)) {
    const t = totals.get(line.account_number) ?? { debit: 0, credit: 0 }
    totals.set(line.account_number, { debit: t.debit + line.debit_amount, credit: t.credit + line.credit_amount })
  }
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({
    data: rows.map((row) => ({
      ...row,
      account_name: row.account_number,
      account_class: Number(row.account_number.charAt(0)),
      default_vat_rate: row.default_vat_rate ?? null,
    })),
  })
  const dynamic = await fetchDynamicVatAccounts(supabase as never, 'company-1')
  const rutor = rutorFromTotals(totals, dynamic)
  const checks = runVatDeclarationChecks(rutor, totals)
  const rcBasisByRate = rcBasisTotalsByRate(totals, dynamic)
  return { rutor, checks, rcBasisByRate }
}

describe('reconcileRcBasisWithCostLines', () => {
  it('drops the pair on a cost account whose momskod reports ruta 20-24, so the declaration counts the purchase once', async () => {
    const rows = chartOf({ '4056': 'reverse_charge_eu_goods' })
    const tx = purchase()
    const before = rcCategory('4056')
    expect(accounts(before)).toEqual(['2645', '2614', '4535', '4598'])
    // Without the settlement the basis lands twice: ruta 20 from 4056 and
    // ruta 21 from 4535, against ruta 30 for one purchase.
    const doubled = await declare(tx, before, rows)
    expect(doubled.rutor.ruta20 + doubled.rutor.ruta21).toBe(2000)
    expect(doubled.checks.map((c) => c.code)).toEqual(['RC_OUTPUT_MISSING'])

    const after = reconcileRcBasisWithCostLines(before, chartVatTreatmentsOf(rows))
    expect(accounts(after)).toEqual(['2645', '2614'])
    const { rutor, checks, rcBasisByRate } = await declare(tx, after, rows)
    expect(rutor.ruta20).toBe(1000)
    expect(rutor.ruta21).toBe(0)
    expect(rutor.ruta30).toBe(250)
    expect(rutor.ruta48).toBe(250)
    expect(checks).toEqual([])
    expect(rcBasisByRate).toEqual({ r25: 1000, r12: 0, r6: 0 })
  })

  it('self-assesses a purchase on an account whose momssats is 12 % at 12 %, where the declaration buckets its basis', async () => {
    const rows = chartOf({ '6540': ['reverse_charge_eu_services', 0.12] })
    const tx = purchase()
    const after = reconcileRcBasisWithCostLines(rcCategory('6540'), chartVatTreatmentsOf(rows))
    expect(shape(after)).toEqual([
      ['2645', 120, 0],
      ['2624', 0, 120],
    ])
    const lines = buildTransactionEntryLines(tx, after)
    expect(roundOre(lines.reduce((s, l) => s + l.debit_amount, 0))).toBe(roundOre(lines.reduce((s, l) => s + l.credit_amount, 0)))

    const { rutor, checks, rcBasisByRate } = await declare(tx, after, rows)
    expect(rutor.ruta21).toBe(1000)
    expect(rutor.ruta30).toBe(0)
    expect(rutor.ruta31).toBe(120)
    expect(rutor.ruta48).toBe(120)
    expect(checks).toEqual([])
    // The per-rate identity holds (basbelopp = moms / sats at each sats), so
    // even a per-verifikat finding could only be advisory: nothing blocks.
    expect(rcBasisByRate).toEqual({ r25: 0, r12: 1000, r6: 0 })
    const gated = withRcBasisGapFindings(checks, { status: 'scanned', gapCount: 1 }, { rutor, rcBasisByRate })
    expect(gated.map((c) => `${c.code}:${c.status}`)).toEqual(['RC_BASIS_MISSING:WARNING'])

    // Settled at 25 % instead, the basis is bucketed at 12 % with no fiktiv
    // moms there: the identity breaks and the per-verifikat finding blocks.
    const at25 = reconcileRcBasisWithCostLines(rcCategory('6540'), chartVatTreatmentsOf(chartOf({ '6540': 'reverse_charge_eu_services' })))
    const wrong = await declare(tx, at25, rows)
    expect(wrong.rcBasisByRate).toEqual({ r25: 0, r12: 1000, r6: 0 })
    expect(withRcBasisGapFindings(wrong.checks, { status: 'scanned', gapCount: 1 }, wrong)
      .map((c) => `${c.code}:${c.status}`)).toEqual(['RC_BASIS_MISSING:ERROR'])
  })

  it('keeps the pair, as the same object, on an ordinary cost account and on one whose momssats is 0 %', () => {
    const before = rcCategory('6540')
    expect(reconcileRcBasisWithCostLines(before, new Map())).toBe(before)
    expect(reconcileRcBasisWithCostLines(before, chartVatTreatmentsOf([{ account_number: '6540' }]))).toBe(before)
    const atZero = rcCategory('4538')
    expect(reconcileRcBasisWithCostLines(atZero, chartVatTreatmentsOf(chartOf({ '4538': ['reverse_charge_eu_services', 0] }))))
      .toBe(atZero)
  })

  it('drops the pair on an unconfigured BAS basis account', () => {
    expect(accounts(reconcileRcBasisWithCostLines(rcCategory('4535'), new Map()))).toEqual(['2645', '2614'])
    expect(shape(reconcileRcBasisWithCostLines(rcCategory('4536'), new Map()))).toEqual([
      ['2645', 120, 0],
      ['2624', 0, 120],
    ])
  })

  it('leaves a result without a basis pair alone', () => {
    const domestic = buildMappingResultFromCategory('expense_software', purchase(), true, 'aktiebolag', 'standard_25')
    expect(reconcileRcBasisWithCostLines(domestic, chartVatTreatmentsOf(chartOf({ '5420': 'reverse_charge_eu_services' }))))
      .toBe(domestic)
  })

  it('decides a mirrored refund on its credit account, where the cost line sits', () => {
    const refund: MappingResult = {
      ...rcCategory('1930'),
      debit_account: '1930',
      credit_account: '6540',
      vat_lines: [
        { account_number: '2645', debit_amount: 0, credit_amount: 250, description: '' },
        { account_number: '2614', debit_amount: 250, credit_amount: 0, description: '' },
        { account_number: '4535', debit_amount: 0, credit_amount: 1000, description: '' },
        { account_number: '4598', debit_amount: 1000, credit_amount: 0, description: '' },
      ],
    }
    expect(accounts(reconcileRcBasisWithCostLines(refund, chartVatTreatmentsOf(chartOf({ '6540': 'reverse_charge_eu_services' })))))
      .toEqual(['2645', '2614'])
    const at6 = chartVatTreatmentsOf(chartOf({ '6540': ['reverse_charge_eu_services', 0.06] }))
    expect(shape(reconcileRcBasisWithCostLines(refund, at6)))
      .toEqual([
        ['2645', 0, 60],
        ['2634', 60, 0],
      ])
    expect(reconcileRcBasisWithCostLines(refund, new Map())).toBe(refund)
  })

  const pattern: MappingResult = {
    ...rcCategory('5420'),
    all_lines_complete: true,
    vat_lines: [
      { account_number: '5420', debit_amount: 600, credit_amount: 0, description: '', business_line: true },
      { account_number: '6540', debit_amount: 400, credit_amount: 0, description: '', business_line: true },
      { account_number: '2645', debit_amount: 250, credit_amount: 0, description: '' },
      { account_number: '2614', debit_amount: 0, credit_amount: 250, description: '' },
      { account_number: '4535', debit_amount: 1000, credit_amount: 0, description: '' },
      { account_number: '4599', debit_amount: 0, credit_amount: 1000, description: '' },
    ],
  }

  it('shrinks a learned pattern pair by the cost lines that report the basis themselves', () => {
    const shrunk = reconcileRcBasisWithCostLines(pattern, chartVatTreatmentsOf(chartOf({ '6540': 'reverse_charge_eu_services' })))
    expect(shape(shrunk)).toEqual([
      ['2645', 250, 0],
      ['2614', 0, 250],
      ['4535', 600, 0],
      ['4599', 0, 600],
    ])
    const tx = purchase()
    const lines = buildTransactionEntryLines(tx, shrunk)
    expect(roundOre(lines.reduce((s, l) => s + l.debit_amount, 0))).toBe(roundOre(lines.reduce((s, l) => s + l.credit_amount, 0)))

    const all = reconcileRcBasisWithCostLines(pattern, chartVatTreatmentsOf(chartOf({
      '5420': 'reverse_charge_eu_services',
      '6540': 'reverse_charge_eu_services',
    })))
    expect(all.vat_lines.map((l) => l.account_number)).toEqual(['5420', '6540', '2645', '2614'])
  })

  it('re-rates the share of a learned pattern on an account at another momssats, and keeps the pair for the rest', () => {
    const settled = reconcileRcBasisWithCostLines(pattern, chartVatTreatmentsOf(chartOf({ '6540': ['reverse_charge_eu_services', 0.12] })))
    expect(shape(settled)).toEqual([
      ['2645', 150, 0],
      ['2614', 0, 150],
      ['4535', 600, 0],
      ['4599', 0, 600],
      ['2645', 48, 0],
      ['2624', 0, 48],
    ])
  })

  it('changes nothing when a settled result is settled again', () => {
    const chart = chartVatTreatmentsOf(chartOf({ '6540': 'reverse_charge_eu_services' }))
    const once = reconcileRcBasisWithCostLines(pattern, chart)
    expect(reconcileRcBasisWithCostLines(once, chart)).toBe(once)

    const reRating = chartVatTreatmentsOf(chartOf({ '6540': ['reverse_charge_eu_services', 0.12] }))
    const reRated = reconcileRcBasisWithCostLines(pattern, reRating)
    expect(reconcileRcBasisWithCostLines(reRated, reRating)).toBe(reRated)

    const single = reconcileRcBasisWithCostLines(rcCategory('4057'), chartVatTreatmentsOf(chartOf({ '4057': ['reverse_charge_eu_goods', 0.12] })))
    expect(reconcileRcBasisWithCostLines(single, chartVatTreatmentsOf(chartOf({ '4057': ['reverse_charge_eu_goods', 0.12] })))).toBe(single)
  })

  it('leaves anything but exactly one set as the builders book it as it is', () => {
    const chart = chartVatTreatmentsOf(chartOf({ '6540': 'reverse_charge_eu_services' }))
    const twoPairs: MappingResult = {
      ...rcCategory('6540'),
      vat_lines: [
        ...rcCategory('6540').vat_lines,
        { account_number: '4531', debit_amount: 1000, credit_amount: 0, description: '' },
        { account_number: '4598', debit_amount: 0, credit_amount: 1000, description: '' },
      ],
    }
    expect(reconcileRcBasisWithCostLines(twoPairs, chart)).toBe(twoPairs)
    // Fiktiv moms on another amount than the pair's is not a builder's set.
    const handBuilt: MappingResult = {
      ...rcCategory('6540'),
      vat_lines: rcCategory('6540').vat_lines.map((l) =>
        l.account_number === '2645' ? { ...l, debit_amount: 200 } : l.account_number === '2614' ? { ...l, credit_amount: 200 } : l),
    }
    expect(reconcileRcBasisWithCostLines(handBuilt, chart)).toBe(handBuilt)
  })
})

describe('reconcileRcBasisWithChart', () => {
  it('reads no chart for a result without a basis pair', async () => {
    const loadChart = vi.fn(async () => new Map())
    const domestic = buildMappingResultFromCategory('expense_software', purchase(), true, 'aktiebolag', 'standard_25')
    expect(await reconcileRcBasisWithChart(domestic, loadChart)).toBe(domestic)
    expect(loadChart).not.toHaveBeenCalled()
  })

  it('settles a pair with the chart it loads', async () => {
    const loadChart = vi.fn(async () => chartVatTreatmentsOf(chartOf({ '4056': 'reverse_charge_eu_goods' })))
    expect(accounts(await reconcileRcBasisWithChart(rcCategory('4056'), loadChart))).toEqual(['2645', '2614'])
    expect(loadChart).toHaveBeenCalledTimes(1)
  })
})

describe('fetchChartVatTreatments / chartVatTreatmentsLoader', () => {
  it('reads the configured momskoder and momssatser of class 4-6 accounts for the company', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ account_number: '4057', default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: '0.12' }] })
    const chart = await fetchChartVatTreatments(supabase as never, 'company-1')
    expect(chart.get('4057')).toEqual({ default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: 0.12 })
    expect(findCall('chart_of_accounts', 'select')).toEqual(['account_number, default_vat_treatment, default_vat_rate'])
    expect(findCall('chart_of_accounts', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('chart_of_accounts', 'in')).toEqual(['account_class', [4, 5, 6]])
    expect(findCall('chart_of_accounts', 'not')).toEqual(['default_vat_treatment', 'is', null])
  })

  it('loads once for a whole batch, and only when asked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ account_number: '6540', default_vat_treatment: 'reverse_charge_eu_services' }] })
    const loadChart = chartVatTreatmentsLoader(supabase as never, 'company-1')
    expect(supabase.from).not.toHaveBeenCalled()
    const first = await loadChart()
    const second = await loadChart()
    expect(second).toBe(first)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed load instead of caching the failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'timeout' } })
    enqueue({ data: [] })
    const loadChart = chartVatTreatmentsLoader(supabase as never, 'company-1')
    await expect(loadChart()).rejects.toThrow()
    expect((await loadChart()).size).toBe(0)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})
