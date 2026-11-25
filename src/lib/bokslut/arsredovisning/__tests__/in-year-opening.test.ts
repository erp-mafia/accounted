import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { isAccumulatedContraAccount } from '@/lib/bookkeeping/bas-data/accumulated-contra-accounts'
import { k2BrPostForAccount } from '@/lib/bokslut/ixbrl/k2-mapper'
import type { AnlaggningAsset } from '../anlaggningstillgangar-note'
import { computeAssetNoteFigures, noteAsset, type AssetDepreciationFigures, type PeriodLike, type TransitionSplitOpening } from '../asset-note-figures'
import { inYearOpeningWarnings, moveInYearOpenings, openingDatedInYear, type InYearOpeningOutcome } from '../in-year-opening'
import { buildK2FixedAssetTables, fixedAssetOpeningCarrying, fixedAssetPostTieOut } from '../k2-fixed-asset-note'
import { k3BrPostForAccount } from '../k3-presentation'
import type { Asset, AssetComponent, TrialBalanceRow } from '@/types'

const FY2024: PeriodLike = { id: 'fy2024', period_start: '2024-01-01', period_end: '2024-12-31' }
const FY2025: PeriodLike = { id: 'fy2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const FY2026: PeriodLike = { id: 'fy2026', period_start: '2026-01-01', period_end: '2026-12-31' }
const PERIODS = [FY2024, FY2025, FY2026]
const postOf = (account: string) => k2BrPostForAccount(account, 'aktiebolag')
const INV = 'InventarierVerktygInstallationer'
const MASKINER = 'MaskinerAndraTekniskaAnlaggningar'
const BYGG = 'ByggnaderMark'

/** 60 000 kr over 60 months from 2023-01-01, 30 000 stated as depreciated per 2025-06-30 (the issue's example). */
function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a1', user_id: 'u', company_id: 'c', name: 'Maskin', category: 'equipment',
    acquisition_date: '2023-01-01', acquisition_cost: 60_000, salvage_value: 0, useful_life_months: 60,
    depreciation_method: 'linear', bas_asset_account: '1220', bas_accumulated_account: '1229',
    bas_expense_account: '7832', restvarde_target: null, disposed_at: null, disposed_proceeds: null,
    disposed_proceeds_vat: 0, disposed_vat_treatment: null, jamkning_amount: 0, jamkning_remaining_months: null,
    jamkning_total_months: null, jamkning_original_input_vat: null, k3_components: null, notes: null,
    created_at: '2025-07-01T00:00:00Z', updated_at: '2025-07-01T00:00:00Z',
    opening_accumulated_depreciation: 30_000, opening_depreciation_date: '2025-06-30',
    ...overrides,
  } as Asset
}

type LedgerRow = Pick<
  TrialBalanceRow,
  'account_number' | 'account_name' | 'opening_debit' | 'opening_credit' | 'period_debit' | 'period_credit' | 'closing_debit' | 'closing_credit'
>

/** A trial balance row: the year opens with `opening` (net debit), `debit` and `credit` move it. */
function row(account: string, opening: number, debit = 0, credit = 0, name = account): LedgerRow {
  const closing = roundOre(opening + debit - credit)
  return {
    account_number: account,
    account_name: name,
    opening_debit: Math.max(opening, 0),
    opening_credit: Math.max(-opening, 0),
    period_debit: debit,
    period_credit: credit,
    closing_debit: Math.max(closing, 0),
    closing_credit: Math.max(-closing, 0),
  }
}

/** The issue's books: 1229 opens 2025 at 24 000, the previous system books 6 000 to June, Accounted 6 049 for the rest. */
const ISSUE_BOOKS = [row('1220', 60_000), row('1229', -24_000, 0, 12_049)]

const NOTHING: AssetDepreciationFigures = { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 }

/** The note as build-data makes it: the figures, the move, the K2 table and its tie to the books per post. */
function run(assets: Asset[], rows: LedgerRow[], period: PeriodLike = FY2025) {
  const before = computeAssetNoteFigures({ assets, postedSchedules: [], fiscalPeriods: PERIODS, currentPeriodId: period.id })
  const { figures: after, outcomes } = moveInYearOpenings({ assets, figures: before, period, postOfAccount: postOf, rows })
  const rollforward: AnlaggningAsset[] = assets.map((a) => ({ ...a, figures: after.get(a.id) ?? NOTHING }))
  const tables = buildK2FixedAssetTables({
    assets: rollforward,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    stated: {},
    postOfAccount: postOf,
    labelOfPost: (post) => post,
    postOrder: [BYGG, MASKINER, INV],
  })
  const onBooks = (post: string, at: 'opening' | 'closing') =>
    roundOre(
      rows
        .filter((r) => postOf(r.account_number) === post)
        .reduce((sum, r) => sum + (at === 'opening' ? r.opening_debit - r.opening_credit : r.closing_debit - r.closing_credit), 0),
    )
  const tie = fixedAssetPostTieOut(tables, new Set(), {
    opening: (post) => onBooks(post, 'opening'),
    closing: (post) => onBooks(post, 'closing'),
  })
  const table = (post: string) => tables.find((t) => t.post === post)!
  const amount = (post: string, key: string) =>
    table(post).blocks.flatMap((block) => block.rows).find((r) => r.key === key)?.amount ?? 0
  return { before, after, outcomes, tables, tie, amount }
}

describe('isAccumulatedContraAccount', () => {
  it('reads 10x8/10x9 to 12x8/12x9 as accumulated av- och nedskrivningar, and never förskott', () => {
    for (const account of ['1019', '1118', '1119', '1129', '1229', '1248', '1249', '1298', '1299', '12291']) {
      expect(isAccumulatedContraAccount(account), account).toBe(true)
    }
    for (const account of ['1088', '1188', '1288', '1220', '1226', '1130', '1319', '1369', '2099']) {
      expect(isAccumulatedContraAccount(account), account).toBe(false)
    }
  })
})

describe('k3BrPostForAccount', () => {
  it("puts balanserade utgifter för utvecklingsarbeten on K3's own post and everything else on the K2 post", () => {
    expect(k3BrPostForAccount('1019', 'aktiebolag')).toBe('BalanseradeUtgifterUtvecklingsarbetenLiknandeArbeten')
    expect(k3BrPostForAccount('1039', 'aktiebolag')).toBe('KoncessionerPatentLicenserVarumarkenLiknandeRattigheter')
    expect(k3BrPostForAccount('1229', 'aktiebolag')).toBe(INV)
  })
})

describe('openingDatedInYear', () => {
  it('is the opening amount of an asset on the books at the start whose stated day is inside the year', () => {
    expect(openingDatedInYear(asset(), FY2025)).toBe(30_000)
    expect(openingDatedInYear(asset({ opening_depreciation_date: '2025-01-01' }), FY2025)).toBe(30_000)
    expect(openingDatedInYear(asset({ opening_depreciation_date: '2025-12-31' }), FY2025)).toBe(30_000)
  })

  it('is 0 for a stated day outside the year, an asset bought in the year and one disposed before it', () => {
    expect(openingDatedInYear(asset({ opening_depreciation_date: '2024-12-31' }), FY2025)).toBe(0)
    expect(openingDatedInYear(asset(), FY2024)).toBe(0)
    expect(openingDatedInYear(asset({ acquisition_date: '2025-01-01' }), FY2025)).toBe(0)
    expect(openingDatedInYear(asset({ disposed_at: '2024-12-31' }), FY2025)).toBe(0)
    expect(openingDatedInYear(asset({ opening_accumulated_depreciation: 0, opening_depreciation_date: null }), FY2025)).toBe(0)
  })
})

describe('moveInYearOpenings', () => {
  it('opens the issue example at the books (24 000) and books 12 049 for the year', () => {
    const r = run([asset()], ISSUE_BOOKS)
    // What the note said before: the whole 30 000 as ingående.
    expect(r.before.get('a1')).toEqual({ ibAck: 30_000, aretsAvskrivning: 6_049, avgaendeAck: 0 })
    expect(r.after.get('a1')).toEqual({ ibAck: 24_000, aretsAvskrivning: 12_049, avgaendeAck: 0 })
    expect(r.outcomes).toEqual([{
      post: INV, inYear: 30_000, registerAtStart: 30_000, booksAtStart: 24_000,
      costAtStart: 60_000, booksCostAtStart: 60_000, moved: 6_000, estimatedAcross: [], reason: 'moved',
    }])
    expect(r.amount(INV, 'depreciation.opening')).toBe(24_000)
    expect(r.amount(INV, 'depreciation.arets')).toBe(12_049)
    expect(r.amount(INV, 'depreciation.closing')).toBe(36_049)
    expect(r.tie).toMatchObject({ errors: [], closingWarnings: [], openingWarnings: [] })
  })

  it("moves the whole year for a stated day on the year's last day, and leaves the next year alone", () => {
    const yearEnd = asset({ opening_accumulated_depreciation: 36_000, opening_depreciation_date: '2025-12-31' })
    const r = run([yearEnd], [row('1220', 60_000), row('1229', -24_000, 0, 12_000)])
    expect(r.before.get('a1')).toEqual({ ibAck: 36_000, aretsAvskrivning: 0, avgaendeAck: 0 })
    expect(r.after.get('a1')).toEqual({ ibAck: 24_000, aretsAvskrivning: 12_000, avgaendeAck: 0 })
    expect(r.tie.openingWarnings).toEqual([])
    // 2026 opens with the 36 000 the books closed 2025 with: nothing is inside that year.
    const next = run([yearEnd], [row('1220', 60_000), row('1229', -36_000, 0, 12_000)], FY2026)
    expect(next.outcomes).toEqual([])
    expect(next.after.get('a1')).toEqual({ ibAck: 36_000, aretsAvskrivning: 12_000, avgaendeAck: 0 })
  })

  it("moves nothing for a stated day on the year's first day when the books held the amount at the start", () => {
    const firstDay = asset({ opening_accumulated_depreciation: 24_000, opening_depreciation_date: '2025-01-01' })
    // Accounted books the plan from 2 January.
    const arets = computeAssetNoteFigures({ assets: [firstDay], postedSchedules: [], fiscalPeriods: PERIODS, currentPeriodId: 'fy2025' }).get('a1')!.aretsAvskrivning
    const r = run([firstDay], [row('1220', 60_000), row('1229', -24_000, 0, arets)])
    expect(r.outcomes).toEqual([{
      post: INV, inYear: 24_000, registerAtStart: 24_000, booksAtStart: 24_000,
      costAtStart: 60_000, booksCostAtStart: 60_000, moved: 0, estimatedAcross: [], reason: 'moved',
    }])
    expect(r.after.get('a1')).toEqual({ ibAck: 24_000, aretsAvskrivning: arets, avgaendeAck: 0 })
    expect(r.tie).toMatchObject({ closingWarnings: [], openingWarnings: [] })
  })

  it('leaves an opening stated before the year as it is', () => {
    const r = run(
      [asset({ opening_accumulated_depreciation: 24_000, opening_depreciation_date: '2024-12-31' })],
      [row('1220', 60_000), row('1229', -24_000, 0, 12_000)],
    )
    expect(r.outcomes).toEqual([])
    expect(r.after.get('a1')).toEqual({ ibAck: 24_000, aretsAvskrivning: 12_000, avgaendeAck: 0 })
  })

  it('leaves an asset bought in the year alone: what it carried in is already on the year’s rows', () => {
    const bought = asset({ acquisition_date: '2025-03-01', opening_accumulated_depreciation: 5_000, opening_depreciation_date: '2025-06-30' })
    const r = run([bought], [row('1220', 0, 60_000), row('1229', 0, 0, 12_000)])
    expect(r.outcomes).toEqual([])
    expect(r.after.get('a1')).toEqual(r.before.get('a1'))
  })

  it('reads the post, not the register account: the books keep the vehicles on 1248/1249, the register says 1229', () => {
    const v1 = asset({ id: 'v1', category: 'vehicle', bas_asset_account: '1226', acquisition_date: '2023-07-01', acquisition_cost: 215_700, opening_accumulated_depreciation: 107_850, opening_depreciation_date: '2025-12-31' })
    const v2 = asset({ id: 'v2', category: 'vehicle', bas_asset_account: '1226', acquisition_date: '2024-07-01', acquisition_cost: 180_000, opening_accumulated_depreciation: 54_000, opening_depreciation_date: '2025-12-31' })
    const r = run([v1, v2], [
      row('1240', 395_700),
      row('1248', -18_000, 0, 36_000, 'Ackumulerade avskrivningar på bilar'),
      row('1249', -64_710, 0, 43_140, 'Ackumulerade avskrivningar på bilar'),
    ])
    expect(r.outcomes[0]).toMatchObject({ registerAtStart: 161_850, booksAtStart: 82_710, moved: 79_140, estimatedAcross: [], reason: 'moved' })
    expect(r.amount(INV, 'depreciation.opening')).toBe(82_710)
    expect(r.amount(INV, 'depreciation.arets')).toBe(79_140)
    // Each takes about its own year (43 140 and 36 000), the post exactly.
    expect(Math.abs(r.after.get('v1')!.aretsAvskrivning - 43_140)).toBeLessThan(150)
    expect(Math.abs(r.after.get('v2')!.aretsAvskrivning - 36_000)).toBeLessThan(150)
    expect(r.tie).toMatchObject({ closingWarnings: [], openingWarnings: [] })
  })

  it('shares the move between assets of different kinds by what each one’s plan writes off before its stated day', () => {
    const computer = asset({ id: 'c1', category: 'computer', bas_asset_account: '1224', acquisition_cost: 36_000, useful_life_months: 36, opening_accumulated_depreciation: 30_000, opening_depreciation_date: '2025-06-30' })
    const r = run([asset(), computer], [row('1220', 96_000), row('1229', -48_000, 0, 6_000 + 6_049 + 6_000 + 6_000)])
    expect(r.outcomes[0]).toMatchObject({ registerAtStart: 60_000, booksAtStart: 48_000, moved: 12_000, estimatedAcross: [], reason: 'moved' })
    // Half a year of each plan: 6 000 on the machine and 6 000 on the computer.
    expect(r.after.get('a1')).toMatchObject({ ibAck: 24_000 })
    expect(r.after.get('c1')).toMatchObject({ ibAck: 24_000 })
    expect(r.tie).toMatchObject({ closingWarnings: [], openingWarnings: [] })
  })

  it('says when the books do not split as the plans do: the move is shared by estimate', () => {
    // The machine's previous system booked once a year, so nothing of 2025 by
    // the stated day; the computer's booked every month. The books cannot say
    // which asset the 6 000 is, and the plans would give 12 000.
    const machine = asset({ opening_accumulated_depreciation: 24_000 })
    const computer = asset({ id: 'c1', category: 'computer', bas_asset_account: '1224', acquisition_cost: 36_000, useful_life_months: 36 })
    const plan = computeAssetNoteFigures({ assets: [machine, computer], postedSchedules: [], fiscalPeriods: PERIODS, currentPeriodId: 'fy2025' })
    const booked = plan.get('a1')!.aretsAvskrivning + plan.get('c1')!.aretsAvskrivning
    const r = run([machine, computer], [row('1220', 96_000), row('1229', -48_000, 0, 6_000 + booked)])
    expect(r.outcomes[0]).toMatchObject({ moved: 6_000, estimatedAcross: ['equipment', 'computer'], reason: 'moved' })
    // The post is the books' either way.
    expect(r.amount(INV, 'depreciation.opening')).toBe(48_000)
  })

  it('shares by the plans without an estimate when the books are within a krona of them', () => {
    // A previous system that booked each month to the öre: 0.60 kr off the plans in all.
    const computer = asset({ id: 'c1', category: 'computer', bas_asset_account: '1224', acquisition_cost: 36_000, useful_life_months: 36 })
    const plan = computeAssetNoteFigures({ assets: [asset(), computer], postedSchedules: [], fiscalPeriods: PERIODS, currentPeriodId: 'fy2025' })
    const booked = plan.get('a1')!.aretsAvskrivning + plan.get('c1')!.aretsAvskrivning
    const r = run([asset(), computer], [row('1220', 96_000), row('1229', -48_000.6, 0, 11_999.4 + booked)])
    expect(r.outcomes[0]).toMatchObject({ moved: 11_999.4, estimatedAcross: [], reason: 'moved' })
  })

  it('never moves more than the openings dated inside the year: the rest stays the opening warning', () => {
    // a2 states nothing; the register plans 36 000 on it before 2025, the
    // books held none of it and caught all of it up in 2025. Only a1's
    // 30 000 can be inside the year.
    const a2 = asset({ id: 'a2', acquisition_date: '2022-01-01', opening_accumulated_depreciation: 0, opening_depreciation_date: null })
    const r = run([asset(), a2], [row('1220', 120_000), row('1229', -24_000, 0, 6_000 + 6_049 + 36_000 + 12_000)])
    expect(r.outcomes[0]).toMatchObject({ inYear: 30_000, registerAtStart: 66_000, booksAtStart: 24_000, moved: 30_000, reason: 'clamped' })
    expect(r.tie.closingWarnings).toEqual([])
    expect(r.tie.openingWarnings).toHaveLength(1)
  })

  it('moves nothing when the books hold more than the register at the start', () => {
    const r = run([asset()], [row('1220', 60_000), row('1229', -40_000, 16_000, 12_049)])
    expect(r.outcomes[0]).toMatchObject({ moved: 0, reason: 'clamped' })
    expect(r.after.get('a1')).toEqual(r.before.get('a1'))
  })

  it('moves nothing while the year is not booked to its end, and the closing warning stays', () => {
    const r = run([asset()], [row('1220', 60_000), row('1229', -24_000, 0, 6_000)])
    expect(r.outcomes[0]).toMatchObject({ moved: 0, reason: 'closing-not-tied' })
    expect(r.after.get('a1')).toEqual(r.before.get('a1'))
    expect(r.tie.closingWarnings).toHaveLength(1)
  })

  it('moves nothing when the rest of the year is depreciated by hand at another rate', () => {
    // 7 000 by hand from July instead of the plan's 6 049.
    const r = run([asset()], [row('1220', 60_000), row('1229', -24_000, 0, 6_000 + 7_000)])
    expect(r.outcomes[0]).toMatchObject({ moved: 0, reason: 'closing-not-tied' })
    expect(r.tie.closingWarnings).toHaveLength(1)
  })

  it('a stated amount a few kronor off what was booked moves nothing; within the krona it moves', () => {
    // The previous system booked 29 998 by the stated day, rounding each month.
    const off = run([asset()], [row('1220', 60_000), row('1229', -24_000, 0, 5_998 + 6_049)])
    expect(off.outcomes[0]).toMatchObject({ moved: 0, reason: 'closing-not-tied' })
    expect(off.tie.closingWarnings).toHaveLength(1)
    const within = run([asset()], [row('1220', 60_000), row('1229', -24_000, 0, 5_999.6 + 6_049)])
    expect(within.outcomes[0]).toMatchObject({ moved: 6_000, reason: 'moved' })
    expect(within.tie).toMatchObject({ closingWarnings: [], openingWarnings: [] })
  })

  it('a cost booked during the year stays the opening warning and is not turned into depreciation', () => {
    // The books got 15 000 of the cost in 2025; the register holds all of it since 2023.
    const r = run([asset()], [row('1220', 45_000, 15_000), row('1229', -24_000, 0, 12_049)])
    expect(r.after.get('a1')).toEqual({ ibAck: 24_000, aretsAvskrivning: 12_049, avgaendeAck: 0 })
    expect(r.tie.openingWarnings).toHaveLength(1)
    expect(roundOre(fixedAssetOpeningCarrying(r.tables[0]) - (45_000 - 24_000))).toBe(15_000)
  })

  it('mark the register lacks keeps its warning while the depreciation rows open at the books', () => {
    const building = asset({ id: 'b1', category: 'building', bas_asset_account: '1110', bas_accumulated_account: '1119', acquisition_date: '2020-01-01', acquisition_cost: 1_200_000, useful_life_months: 600, opening_accumulated_depreciation: 132_000, opening_depreciation_date: '2025-06-30' })
    const r = run([building], [row('1110', 1_200_000), row('1130', 500_000), row('1119', -120_000, 0, 12_000 + 12_099)])
    expect(r.after.get('b1')).toMatchObject({ ibAck: 120_000, aretsAvskrivning: 24_099 })
    expect(r.tie.closingWarnings).toHaveLength(1)
  })

  it('an asset with depreciation the register lacks keeps the post as it was, with its warning', () => {
    const r = run([asset()], [row('1220', 100_000), row('1229', -34_000, 0, 12_049 + 8_000)])
    expect(r.outcomes[0]).toMatchObject({ moved: 0, reason: 'closing-not-tied' })
    expect(r.tie.closingWarnings).toHaveLength(1)
  })

  it('an asset on an account of another post keeps the post as it was, with its warning', () => {
    // The register says 1220, the books hold the machine on 1210/1219.
    const r = run([asset()], [row('1210', 60_000), row('1219', -24_000, 0, 12_049)])
    expect(r.outcomes[0]).toMatchObject({ post: INV, moved: 0, reason: 'closing-not-tied' })
    expect(r.after.get('a1')).toEqual(r.before.get('a1'))
    expect(r.tie.closingWarnings).toHaveLength(1)
  })

  it('a disposal the register lacks: nothing moves when it outweighs the in-year part, and the warning stays', () => {
    // A machine of 50 000 with 20 000 depreciated, on the books at the start, sold in 2025.
    const r = run([asset()], [row('1220', 110_000, 0, 50_000), row('1229', -44_000, 20_000, 12_049)])
    expect(r.outcomes[0]).toMatchObject({ registerAtStart: 30_000, booksAtStart: 44_000, moved: 0, reason: 'clamped' })
    expect(r.tie.openingWarnings).toHaveLength(1)
  })

  it('a disposal the register lacks that is smaller than the in-year part nets into the year, and the warning stays', () => {
    // The sold machine had 4 000 depreciated: the post opens at the books, the year shows the net.
    const r = run([asset()], [row('1220', 70_000, 0, 10_000), row('1229', -28_000, 4_000, 12_049)])
    expect(r.outcomes[0]).toMatchObject({ registerAtStart: 30_000, booksAtStart: 28_000, moved: 2_000, reason: 'moved' })
    expect(r.amount(INV, 'depreciation.opening')).toBe(28_000)
    expect(r.tie.openingWarnings).toHaveLength(1)
  })

  it('keeps the closing of an asset disposed of in the year at zero', () => {
    const sold = asset({ disposed_at: '2025-09-30' })
    const r = run([sold], [row('1220', 60_000, 0, 60_000), row('1229', -24_000, 24_000 + 6_000 + 3_000, 6_000 + 3_000)])
    const f = r.after.get('a1')!
    expect(f.ibAck).toBe(24_000)
    expect(roundOre(f.ibAck + f.aretsAvskrivning - f.avgaendeAck)).toBe(0)
  })

  it('leaves a post with nedskrivningar on its books as it is', () => {
    const r = run([asset()], [...ISSUE_BOOKS, row('1228', -5_000, 0, 0, 'Ackumulerade nedskrivningar på inventarier')])
    // The books' avskrivningar leave the nedskrivningar out: 24 000, not 29 000.
    expect(r.outcomes[0]).toMatchObject({ booksAtStart: 24_000, moved: 0, reason: 'write-downs' })
    expect(r.after.get('a1')).toEqual(r.before.get('a1'))
  })

  it('leaves a post with nedskrivningar in the register as it is', () => {
    const writtenDown = asset({
      value_adjustments: [{
        id: 'w1', asset_id: 'a1', component_id: null, kind: 'impairment', adjustment_date: '2024-12-31',
        fiscal_period_id: 'fy2024', amount: 5_000, recoverable_amount: null, reason: 'Värdenedgång',
        expense_account: '7732', accumulated_account: '1228', journal_entry_id: 'je-w1', created_at: '2024-12-31T00:00:00Z',
      }],
    })
    const r = run([writtenDown], [...ISSUE_BOOKS, row('1228', -5_000)])
    expect(r.outcomes[0]).toMatchObject({ moved: 0, reason: 'write-downs' })
  })

  describe('a component asset (K3)', () => {
    function component(id: string, cost: number, life: number, opening: number, date: string): AssetComponent {
      return {
        id, user_id: 'u', company_id: 'c', asset_id: 'k1', name: id, cost, useful_life_months: life, salvage_value: 0,
        acquisition_date: '2023-01-01', depreciation_start_date: '2023-01-01', opening_accumulated_depreciation: opening,
        opening_depreciation_date: date, replaces_component_id: null, derecognised_at: null,
        derecognition_journal_entry_id: null, derecognition_depreciation: 0, sort_order: id === 'stomme' ? 0 : 1,
        created_at: '2025-07-01T00:00:00Z', updated_at: '2025-07-01T00:00:00Z',
      }
    }
    // The stomme states 8 000 per 2024-12-31, the motor 10 000 per 2025-06-30:
    // the register keeps 18 000 per the later day on the asset.
    const machine = asset({
      id: 'k1', category: 'machinery', bas_asset_account: '1210', bas_accumulated_account: '1219',
      acquisition_cost: 60_000, useful_life_months: 120,
      opening_accumulated_depreciation: 18_000, opening_depreciation_date: '2025-06-30',
      components: [component('stomme', 40_000, 120, 8_000, '2024-12-31'), component('motor', 20_000, 60, 10_000, '2025-06-30')],
      k3_components: [
        { component_id: 'stomme', name: 'stomme', cost: 40_000, useful_life_months: 120, salvage_value: 0 },
        { component_id: 'motor', name: 'motor', cost: 20_000, useful_life_months: 60, salvage_value: 0 },
      ],
    })

    it('reads a K3 transition split as the note does: the plain asset before it, its components from it', () => {
      // Split at 2025-01-01 with what was depreciated carried into the
      // components per 2024-12-31; before the split it was a plain asset
      // taken over with 20 000 stated per 2024-06-30.
      const split: TransitionSplitOpening = {
        asset_id: 'k1', split_date: '2025-01-01', original_cost: '60000.00',
        original_opening: '20000.00', original_opening_date: '2024-06-30', original_salvage: '0.00',
      }
      const splitMachine = asset({
        ...machine,
        opening_accumulated_depreciation: 24_000, opening_depreciation_date: '2024-12-31',
        components: [component('stomme', 40_000, 120, 12_000, '2024-12-31'), component('motor', 20_000, 60, 12_000, '2024-12-31')],
      })
      expect(openingDatedInYear(noteAsset(splitMachine, split, FY2024.period_start), FY2024)).toBe(20_000)
      expect(openingDatedInYear(noteAsset(splitMachine, split, FY2025.period_start), FY2025)).toBe(0)
    })

    it('counts only the components whose stated day is inside the year', () => {
      expect(openingDatedInYear(machine, FY2025)).toBe(10_000)
    })

    it('moves what the motor booked in the year before its stated day', () => {
      // The books opened 2025 with 8 000 on the stomme and 8 000 on the motor;
      // 2 000 more was booked on the motor before July, then the plan's year.
      const arets = computeAssetNoteFigures({ assets: [machine], postedSchedules: [], fiscalPeriods: PERIODS, currentPeriodId: 'fy2025' }).get('k1')!.aretsAvskrivning
      const r = run([machine], [row('1210', 60_000), row('1219', -16_000, 0, 2_000 + arets)])
      expect(r.outcomes[0]).toMatchObject({ post: MASKINER, inYear: 10_000, registerAtStart: 18_000, booksAtStart: 16_000, moved: 2_000, reason: 'moved' })
      expect(r.amount(MASKINER, 'depreciation.opening')).toBe(16_000)
      expect(r.tie).toMatchObject({ closingWarnings: [], openingWarnings: [] })
    })

    it('shares a move with another kind of asset by the plans of its components stated inside the year', () => {
      // On the same post, a computer for production stated 30 000 per 2025-06-30.
      const computer = asset({ id: 'c1', category: 'computer', bas_asset_account: '1214', bas_accumulated_account: '1219', acquisition_cost: 36_000, useful_life_months: 36 })
      const arets = computeAssetNoteFigures({ assets: [machine, computer], postedSchedules: [], fiscalPeriods: PERIODS, currentPeriodId: 'fy2025' })
      const booked = arets.get('k1')!.aretsAvskrivning + arets.get('c1')!.aretsAvskrivning
      // The books opened 2025 with 16 000 on the machine and 24 000 on the
      // computer; the motor's 2 000 and the computer's 6 000 were booked before July.
      const r = run([machine, computer], [row('1210', 60_000), row('1214', 36_000), row('1219', -40_000, 0, 8_000 + booked)])
      expect(r.outcomes[0]).toMatchObject({ post: MASKINER, inYear: 40_000, moved: 8_000, estimatedAcross: [], reason: 'moved' })
      // The motor's half year (2 000), not the asset's plan over its stomme too (3 000).
      expect(r.after.get('k1')).toMatchObject({ ibAck: 16_000 })
      expect(r.after.get('c1')).toMatchObject({ ibAck: 24_000 })
    })

    it('never moves the opening of a component stated before the year', () => {
      const arets = computeAssetNoteFigures({ assets: [machine], postedSchedules: [], fiscalPeriods: PERIODS, currentPeriodId: 'fy2025' }).get('k1')!.aretsAvskrivning
      // 12 000 short at the start: only the motor's 10 000 can be inside the year.
      const r = run([machine], [row('1210', 60_000), row('1219', -6_000, 0, 12_000 + arets)])
      expect(r.outcomes[0]).toMatchObject({ inYear: 10_000, moved: 10_000, reason: 'clamped' })
      expect(r.amount(MASKINER, 'depreciation.opening')).toBe(8_000)
    })
  })
})

describe('inYearOpeningWarnings (the K3 note, which ties only its total and prints per category)', () => {
  const outcome = (overrides: Partial<InYearOpeningOutcome>): InYearOpeningOutcome => ({
    post: INV, inYear: 30_000, registerAtStart: 30_000, booksAtStart: 24_000, costAtStart: 60_000, booksCostAtStart: 60_000,
    moved: 6_000, estimatedAcross: [], reason: 'moved', ...overrides,
  })
  const label = (post: string) => (post === INV ? 'Inventarier, verktyg och installationer' : post)
  const category = (name: string) => ({ equipment: 'Inventarier', computer: 'Datorer' })[name] ?? name
  const warn = (outcomes: InYearOpeningOutcome[]) => inYearOpeningWarnings(outcomes, label, category).map((text) => text.replace(/ /g, ' '))

  it('says nothing for a post that now opens as the books do', () => {
    expect(warn([outcome({})])).toEqual([])
  })

  it('names a post whose opening could not be placed, with both figures', () => {
    const [warning] = warn([outcome({ moved: 0, reason: 'closing-not-tied' })])
    expect(warning).toContain(
      'Anläggningsnoten för Inventarier, verktyg och installationer: ackumulerade avskrivningar vid årets ingång (30 000 kr) stämmer inte med postens bokförda (24 000 kr).',
    )
    expect(warning).toContain('redan avskrivet belopp är det som var bokfört det datumet')
  })

  it('names what is left after a clamp', () => {
    const [warning] = warn([outcome({ registerAtStart: 66_000, moved: 30_000, reason: 'clamped' })])
    expect(warning).toContain('(36 000 kr) stämmer inte med postens bokförda (24 000 kr)')
  })

  it('names a post with nedskrivningar whose avskrivningar differ, and not one whose do not', () => {
    expect(warn([outcome({ moved: 0, reason: 'write-downs' })])).toHaveLength(1)
    // Stated per the year's first day: the books held the amount at the start.
    expect(warn([outcome({ booksAtStart: 30_000, moved: 0, reason: 'write-downs' })])).toEqual([])
  })

  it('names a move made while the anskaffningsvärden differ: the move may hold that difference', () => {
    const [warning] = warn([outcome({ costAtStart: 60_000, booksCostAtStart: 70_000 })])
    expect(warning).toContain('ingående anskaffningsvärden (60 000 kr) stämmer inte med postens bokförda (70 000 kr)')
    // Nothing moved: the anskaffningsvärden are not this note's to explain.
    expect(warn([outcome({ booksAtStart: 30_000, moved: 0, booksCostAtStart: 70_000 })])).toEqual([])
  })

  it('names a move shared between categories by estimate', () => {
    const [warning] = warn([outcome({ estimatedAcross: ['equipment', 'computer'] })])
    expect(warning).toContain('6 000 kr av årets avskrivningar bokfördes före de datum som redan avskrivet belopp är angivet per')
    expect(warning).toContain('fördelar det mellan Inventarier och Datorer efter tillgångarnas avskrivningsplaner')
    expect(warn([outcome({ estimatedAcross: ['equipment'] })])).toEqual([])
  })
})
