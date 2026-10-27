/**
 * Planenlig avskrivning after a changed estimate, and the final true-up.
 *
 * K3 10.9 and K2 10.26 (with its kommentar): a changed useful life or
 * salvage value is applied "framåt i tiden". What is left of the
 * depreciable amount (cost - salvage - opening - posted) is spread over the
 * remaining life from the start of the year of the change. Before this the
 * plain path recomputed every year from cost, so 100 000 kr over 10 years
 * changed to 20 years after year 3 booked 30 000 + 17 x 5 000 = 115 000 kr.
 *
 * The period that reaches the end of the life takes exactly what is left
 * when the register holds the whole history: 10 000 kr over 36 months from
 * 10 February booked 9 999 kr before.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPagedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import type { Asset } from '@/types'

const listAssets = vi.hoisted(() => vi.fn())
vi.mock('../asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../asset-service')>()),
  listAssets: (...args: unknown[]) => listAssets(...args),
}))

const {
  computeAnnualDepreciation,
  postedDepreciationHistory,
  priorDepreciationTotal,
  proposeAnnualPostings,
} = await import('../depreciation-engine')
const { AssetDisposalBlockedError, buildAssetDisposalPlan } = await import('../asset-service')
type PostedDepreciationPeriod = import('../depreciation-engine').PostedDepreciationPeriod

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'co-1',
    name: 'Maskin',
    category: 'machinery',
    acquisition_date: '2020-01-01',
    acquisition_cost: 100_000,
    salvage_value: 0,
    useful_life_months: 120,
    depreciation_method: 'linear',
    bas_asset_account: '1210',
    bas_accumulated_account: '1219',
    bas_expense_account: '7831',
    restvarde_target: null,
    disposed_at: null,
    disposed_proceeds: null,
    disposed_proceeds_vat: 0,
    disposed_vat_treatment: null,
    jamkning_amount: 0,
    jamkning_remaining_months: null,
    jamkning_total_months: null,
    jamkning_original_input_vat: null,
    k3_components: null,
    opening_accumulated_depreciation: 0,
    opening_depreciation_date: null,
    notes: null,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
    ...overrides,
  }
}

const year = (y: number) => ({ period_start: `${y}-01-01`, period_end: `${y}-12-31` })
const years = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => year(from + i))

/**
 * Posts every year in order the way the year-end flow does: each year sees
 * the periods posted before it. `edits` change the asset from a given year
 * on (the change is made during that year, before its depreciation).
 */
function runLife(
  asset: Asset,
  periods: { period_start: string; period_end: string }[],
  edits: Record<string, Partial<Asset>> = {},
): PostedDepreciationPeriod[] {
  const posted: PostedDepreciationPeriod[] = []
  let current = asset
  for (const period of periods) {
    const edit = edits[period.period_start]
    if (edit) current = { ...current, ...edit }
    const { amount } = computeAnnualDepreciation(current, period, posted)
    if (amount > 0) posted.push({ ...period, amount })
  }
  return posted
}

const total = (posted: PostedDepreciationPeriod[]) =>
  roundOre(posted.reduce((sum, p) => sum + p.amount, 0))

describe('a changed useful life is applied prospectively', () => {
  it('100 000 kr over 10 years changed to 20 years after year 3 totals 100 000, not 115 000', () => {
    const posted = runLife(makeAsset(), years(2020, 2045), {
      '2023-01-01': { useful_life_months: 240 },
    })
    expect(posted.slice(0, 3).map((p) => p.amount)).toEqual([10_000, 10_000, 10_000])
    // 70 000 left over the 17 remaining years: 4 117.65 a year.
    expect(posted[3]).toEqual({ ...year(2023), amount: 4_118 })
    // The last year of the 20-year life is 2039, which takes what is left.
    expect(posted[posted.length - 1].period_start).toBe('2039-01-01')
    expect(posted).toHaveLength(20)
    expect(total(posted)).toBe(100_000)
    for (const p of posted.slice(3)) {
      expect(Math.abs(p.amount - 70_000 / 17)).toBeLessThan(2)
    }
  })

  it('a shortened life spreads what is left over the shorter remaining life', () => {
    // 10 years shortened to 5 after year 3: 70 000 left over 2 years.
    const posted = runLife(makeAsset(), years(2020, 2030), {
      '2023-01-01': { useful_life_months: 60 },
    })
    expect(posted.map((p) => p.amount)).toEqual([10_000, 10_000, 10_000, 35_000, 35_000])
    expect(total(posted)).toBe(100_000)
  })

  it('a life shortened to end before the year of the change leaves the rest to that year', () => {
    // 10 years shortened to 2 after year 3: the new life ended 2021-12-31.
    const posted = runLife(makeAsset(), years(2020, 2030), {
      '2023-01-01': { useful_life_months: 24 },
    })
    expect(posted.map((p) => p.amount)).toEqual([10_000, 10_000, 10_000, 70_000])
    expect(total(posted)).toBe(100_000)
  })

  it('a change in the middle of a brutet year runs from that year start', () => {
    // 60 000 kr over 5 years from 2022-07-01 in a July-June year, changed
    // to 8 years from the 2024/25 year: 36 000 left over 66 months.
    const fy = (y: number) => ({ period_start: `${y}-07-01`, period_end: `${y + 1}-06-30` })
    const posted = runLife(
      makeAsset({ acquisition_date: '2022-07-01', acquisition_cost: 60_000, useful_life_months: 60 }),
      [2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031].map(fy),
      { '2024-07-01': { useful_life_months: 96 } },
    )
    expect(posted.slice(0, 3).map((p) => p.amount)).toEqual([12_000, 12_000, Math.round((36_000 * 12) / 72)])
    expect(posted[posted.length - 1].period_end).toBe('2030-06-30')
    expect(total(posted)).toBe(60_000)
  })
})

describe('a changed salvage value is applied prospectively', () => {
  it('a raised salvage value stops the asset at the new salvage value', () => {
    // 10 years, salvage set to 20 000 after year 3: 50 000 left over 7 years.
    const posted = runLife(makeAsset(), years(2020, 2032), {
      '2023-01-01': { salvage_value: 20_000 },
    })
    expect(posted[3].amount).toBe(Math.round(50_000 / 7))
    expect(total(posted)).toBe(80_000)
    expect(posted[posted.length - 1].period_start).toBe('2029-01-01')
  })

  it('a lowered salvage value spreads the extra amount over the remaining life', () => {
    // 10 000 salvage from the start (9 000 a year), lowered to 0 after year 2.
    const posted = runLife(makeAsset({ salvage_value: 10_000 }), years(2020, 2032), {
      '2022-01-01': { salvage_value: 0 },
    })
    expect(posted.slice(0, 2).map((p) => p.amount)).toEqual([9_000, 9_000])
    expect(posted[2].amount).toBe(Math.round(82_000 / 8))
    expect(total(posted)).toBe(100_000)
  })

  it('a salvage value raised above the book value books nothing more and never goes below it', () => {
    const posted = runLife(makeAsset(), years(2020, 2032), {
      '2023-01-01': { salvage_value: 80_000 },
    })
    expect(posted.map((p) => p.amount)).toEqual([10_000, 10_000, 10_000])
  })
})

describe('the final period takes exactly what is left', () => {
  it('10 000 kr over 36 months from 10 February totals 10 000, not 9 999', () => {
    const asset = makeAsset({ acquisition_date: '2026-02-10', acquisition_cost: 10_000, useful_life_months: 36 })
    const posted = runLife(asset, years(2026, 2030))
    // 325/365 of 3 333.33, two full years, then what is left (the old engine
    // booked 365 for the last 40 days and stranded a krona).
    expect(posted.map((p) => p.amount)).toEqual([2_968, 3_333, 3_333, 366])
    expect(total(posted)).toBe(10_000)
  })

  it('also when rounding went up: never more than cost', () => {
    // 1 000 kr over 7 months from 2024-06-15 in calendar years.
    const asset = makeAsset({ acquisition_date: '2024-06-15', acquisition_cost: 1_000, useful_life_months: 7 })
    const posted = runLife(asset, years(2024, 2026))
    expect(total(posted)).toBe(1_000)
  })

  it('an öre cost lands öre-exact', () => {
    const asset = makeAsset({ acquisition_date: '2023-03-01', acquisition_cost: 12_345.67, useful_life_months: 60 })
    const posted = runLife(asset, years(2023, 2029))
    expect(total(posted)).toBe(12_345.67)
  })
})

describe('an asset whose estimates never changed', () => {
  it.each([
    { label: 'calendar years from 1 January', acquisition_date: '2020-01-01', cost: 100_000, life: 120 },
    { label: 'mid-year acquisition', acquisition_date: '2021-07-01', cost: 36_000, life: 36 },
    { label: 'odd date and cost', acquisition_date: '2022-02-10', cost: 54_321, life: 50 },
    { label: 'salvage value', acquisition_date: '2021-04-01', cost: 80_000, life: 48, salvage: 8_000 },
  ])('gets the same amounts as before in every year but the last ($label)', ({ acquisition_date, cost, life, salvage }) => {
    const asset = makeAsset({ acquisition_date, acquisition_cost: cost, useful_life_months: life, salvage_value: salvage ?? 0 })
    const posted = runLife(asset, years(2020, 2035))
    // Before: each year computed on its own, with nothing about the history.
    const before = years(2020, 2035)
      .map((period) => ({ ...period, amount: computeAnnualDepreciation(asset, period).amount }))
      .filter((p) => p.amount > 0)
    expect(posted.map((p) => p.period_start)).toEqual(before.map((p) => p.period_start))
    expect(posted.slice(0, -1)).toEqual(before.slice(0, -1))
    // The last year absorbs the rounding and the day-share drift between
    // 365- and 366-day years (a mid-year acquisition over a leap year booked
    // 36 016 kr of a 36 000 kr cost before): the total lands on cost - salvage.
    expect(total(posted)).toBe(cost - (salvage ?? 0))
  })
})

describe('history the register does not hold', () => {
  it('an asset acquired before the first posted year is not re-planned and gets no catch-up', () => {
    // Acquired 2020, booked 2020-2022 in the previous system without an
    // opening amount on the register; Accounted posted 2023 and 2024.
    const asset = makeAsset()
    const posted: PostedDepreciationPeriod[] = [
      { ...year(2023), amount: 10_000 },
      { ...year(2024), amount: 10_000 },
    ]
    // Life changed to 20 years: the engine cannot know the book value, so it
    // keeps the plain plan (capped) instead of catching up 2020-2022.
    const edited = { ...asset, useful_life_months: 240 }
    expect(computeAnnualDepreciation(edited, year(2025), posted).amount).toBe(5_000)
    // The final year of the original life is not trued up to "what is left".
    expect(computeAnnualDepreciation(asset, year(2029), [...posted, ...years(2025, 2028).map((y) => ({ ...y, amount: 10_000 }))]).amount).toBe(10_000)
  })

  it('a skipped year is not re-planned either', () => {
    const asset = { ...makeAsset(), useful_life_months: 60 }
    const posted: PostedDepreciationPeriod[] = [
      { ...year(2020), amount: 10_000 },
      { ...year(2022), amount: 10_000 },
    ]
    expect(computeAnnualDepreciation(asset, year(2023), posted).amount).toBe(20_000)
  })

  it('an unparseable date answers instead of throwing (the MCP staging fixtures send one)', () => {
    expect(() =>
      computeAnnualDepreciation(makeAsset({ acquisition_date: 'not-a-date' }), year(2025), []),
    ).not.toThrow()
  })

  it('a bare total keeps the plain plan and is capped at what is left', () => {
    const edited = makeAsset({ useful_life_months: 240 })
    expect(computeAnnualDepreciation(edited, year(2023), 30_000).amount).toBe(5_000)
    expect(computeAnnualDepreciation(makeAsset(), year(2029), 95_000).amount).toBe(5_000)
  })
})

describe('an asset with an opening balance', () => {
  const migrated = makeAsset({
    acquisition_date: '2022-01-01',
    useful_life_months: 60,
    opening_accumulated_depreciation: 40_000,
    opening_depreciation_date: '2023-12-31',
  })

  it('unchanged: the same amounts as before', () => {
    const posted = runLife(migrated, years(2024, 2028))
    expect(posted.map((p) => p.amount)).toEqual([20_000, 20_000, 20_000])
  })

  it('a life extended after posting spreads what is left from the year of the change', () => {
    // 2024 posted 20 000 on the 5-year plan; extended to 8 years in 2025:
    // 40 000 left over 2025-2029.
    const posted = runLife(migrated, years(2024, 2031), {
      '2025-01-01': { useful_life_months: 96 },
    })
    expect(posted.map((p) => p.amount)).toEqual([20_000, 8_000, 8_000, 8_000, 8_000, 8_000])
    expect(40_000 + total(posted)).toBe(100_000)
  })
})

describe('the disposal plan charges what the proposal booked', () => {
  const periods = years(2026, 2029).map((y) => ({ id: `p-${y.period_start.slice(0, 4)}`, ...y }))
  const asset = makeAsset({ acquisition_date: '2026-02-10', acquisition_cost: 10_000, useful_life_months: 36 })
  const schedules = runLife(asset, years(2026, 2029)).map((p) => ({
    fiscal_period_id: `p-${p.period_start.slice(0, 4)}`,
    planned_depreciation: p.amount,
    journal_entry_id: `je-${p.period_start.slice(0, 4)}`,
  }))
  const scrap = {
    disposal_type: 'scrap' as const,
    disposed_at: '2029-12-31',
    disposed_proceeds: 0,
    fiscal_period_id: 'p-2029',
  }

  it('scrapping after the trued-up final year was posted is not refused as a mismatch', () => {
    expect(schedules.map((s) => s.planned_depreciation)).toEqual([2_968, 3_333, 3_333, 366])
    const plan = buildAssetDisposalPlan({
      asset,
      input: scrap,
      fiscalPeriod: periods[3],
      periods,
      schedules,
    })
    expect(plan.currentDepreciation).toBe(0)
    expect(plan.accumulatedDepreciation).toBe(10_000)
    expect(plan.gainOrLoss).toBe(0)
  })

  it('accepts a final year posted before this change, at the old charge', () => {
    // Before the true-up the last 40 days were booked at 365: the disposal
    // takes the books as they are and the stranded krona is the scrapping loss.
    const legacy = schedules.map((s) => (s.fiscal_period_id === 'p-2029' ? { ...s, planned_depreciation: 365 } : s))
    const plan = buildAssetDisposalPlan({ asset, input: scrap, fiscalPeriod: periods[3], periods, schedules: legacy })
    expect(plan.currentDepreciation).toBe(0)
    expect(plan.accumulatedDepreciation).toBe(9_999)
    expect(plan.gainOrLoss).toBe(-1)
  })

  it('still refuses a posted year that matches neither charge', () => {
    const wrong = schedules.map((s) => (s.fiscal_period_id === 'p-2029' ? { ...s, planned_depreciation: 3_333 } : s))
    expect(() =>
      buildAssetDisposalPlan({ asset, input: scrap, fiscalPeriod: periods[3], periods, schedules: wrong }),
    ).toThrow(AssetDisposalBlockedError)
  })

  it('without the period dates it falls back to the bare total, as before', () => {
    expect(() =>
      buildAssetDisposalPlan({
        asset,
        input: scrap,
        fiscalPeriod: periods[3],
        periods: periods.map(({ id, period_start }) => ({ id, period_start })),
        schedules,
      }),
    ).toThrow(AssetDisposalBlockedError)
  })

  it('a disposal after a changed life charges the re-planned amount', () => {
    const edited = makeAsset({ useful_life_months: 240 })
    const dated = years(2020, 2023).map((y) => ({ id: `p-${y.period_start.slice(0, 4)}`, ...y }))
    const plan = buildAssetDisposalPlan({
      asset: edited,
      input: { ...scrap, disposed_at: '2023-12-31', fiscal_period_id: 'p-2023' },
      fiscalPeriod: dated[3],
      periods: dated,
      schedules: [2020, 2021, 2022].map((y) => ({
        fiscal_period_id: `p-${y}`,
        planned_depreciation: 10_000,
        journal_entry_id: `je-${y}`,
      })),
    })
    expect(plan.currentDepreciation).toBe(4_118)
    expect(plan.accumulatedDepreciation).toBe(34_118)
  })
})

describe('the posted history helpers', () => {
  it('postedDepreciationHistory maps posted rows to their periods and skips unposted ones', () => {
    const periods = [
      { id: 'p1', ...year(2023) },
      { id: 'p2', ...year(2024) },
    ]
    expect(
      postedDepreciationHistory(
        [
          { fiscal_period_id: 'p1', planned_depreciation: '10000.00', journal_entry_id: 'je1' },
          { fiscal_period_id: 'p2', planned_depreciation: 5_000, journal_entry_id: null },
        ],
        periods,
      ),
    ).toEqual([{ ...year(2023), amount: 10_000 }])
  })

  it('postedDepreciationHistory returns null when a posted row has no known period', () => {
    expect(
      postedDepreciationHistory([{ fiscal_period_id: 'gone', planned_depreciation: 1, journal_entry_id: 'je' }], []),
    ).toBeNull()
  })

  it('priorDepreciationTotal counts only periods that end before the period', () => {
    const history = [
      { ...year(2023), amount: 10_000 },
      { ...year(2025), amount: 7_000 },
    ]
    expect(priorDepreciationTotal(history, '2024-01-01')).toBe(10_000)
    expect(priorDepreciationTotal(12_345.678, '2024-01-01')).toBe(12_345.68)
  })
})

describe('proposeAnnualPostings hands the engine the posted history', () => {
  it('re-plans an asset whose life was changed after posting', async () => {
    listAssets.mockResolvedValue([makeAsset({ id: 'a-1', useful_life_months: 240 })])
    const { supabase, calls } = createPagedMockSupabase({
      fiscal_periods: [{ id: 'p-2023', name: '2023', ...year(2023) }],
      depreciation_schedules: [2020, 2021, 2022].map((y) => ({
        id: `s-${y}`,
        asset_id: 'a-1',
        planned_depreciation: '10000.00',
        journal_entry_id: `je-${y}`,
        fiscal_period_id: `p-${y}`,
        fiscal_period: year(y),
      })),
    })

    const proposal = await proposeAnnualPostings(supabase as never, 'co', 'p-2023')

    expect(proposal.items).toHaveLength(1)
    expect(proposal.items[0].amount).toBe(4_118)
    expect(proposal.items[0].netBookValueAfter).toBe(100_000 - 30_000 - 4_118)
    const selects = calls
      .filter((c) => c.table === 'depreciation_schedules' && c.method === 'select')
      .map((c) => c.args[0])
    expect(selects).toContain(
      'asset_id, planned_depreciation, journal_entry_id, fiscal_period_id, fiscal_period:fiscal_periods!depreciation_schedules_fiscal_period_id_fkey(period_start, period_end)',
    )
  })
})
