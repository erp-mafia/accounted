import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Asset } from '@/types'

/**
 * Fond för utvecklingsutgifter (ÅRL 4 kap. 2 § andra stycket and 8 §, K3
 * 18.3A): the fund follows the company's own development (the register's
 * assets marked own_development), not everything on 1010-1019. The year's
 * capitalisations go to it; it comes back ONLY with the year's depreciation,
 * write-down and disposal of marked assets. Nothing is proposed while the
 * register cannot say what the fund stands for.
 */

const trialBalanceMock = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalanceMock(...args),
}))
const proposeMock = vi.fn()
vi.mock('@/lib/bokslut/assets/depreciation-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/depreciation-engine')>()),
  proposeAnnualPostings: (...args: unknown[]) => proposeMock(...args),
}))
const listAssetsMock = vi.fn()
vi.mock('@/lib/bokslut/assets/asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/asset-service')>()),
  listAssets: (...args: unknown[]) => listAssetsMock(...args),
}))
const carryingMock = vi.fn()
vi.mock('@/lib/bokslut/assets/register-carrying-amounts', () => ({
  loadCarryingAmountsAt: (...args: unknown[]) => carryingMock(...args),
}))

const { buildDevelopmentFundProposal, developmentFundFigures, developmentFundLines } = await import('../development-fund')

type Row = {
  account_number: string
  opening_debit?: number
  opening_credit?: number
  period_debit?: number
  period_credit?: number
  closing_debit?: number
  closing_credit?: number
}
function rows(list: Row[]) {
  return list.map((row) => ({
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...row,
  }))
}

const PERIOD = { id: 'fy', period_start: '2026-01-01', period_end: '2026-12-31' }

function asset(overrides: Partial<Asset>): Asset {
  return {
    id: 'a-1',
    name: 'Plattform',
    category: 'immaterial',
    acquisition_date: '2024-03-01',
    acquisition_cost: 100_000,
    bas_asset_account: '1010',
    disposed_at: null,
    own_development: true,
    components: [],
    k3_components: null,
    ...overrides,
  } as Asset
}

/** The register's carrying amount per asset id, at the opening day and at the balansdag. */
function registerCarrying(atOpening: Record<string, number>, atClose: Record<string, number>) {
  carryingMock.mockImplementation(async (_s: unknown, _c: unknown, assets: Asset[], day: string) =>
    new Map(assets.map((row) => [row.id, (day === PERIOD.period_end ? atClose : atOpening)[row.id] ?? 0])),
  )
}

function client(model: string | null = 'capitalise') {
  return createTableMockSupabase({
    companies: { data: { accounting_framework: 'k3', development_expenditure_model: model } },
    fiscal_periods: { data: PERIOD },
  })
}

async function build(model: string | null = 'capitalise') {
  return buildDevelopmentFundProposal(client(model).supabase as never, 'co', 'fy', 'aktiebolag')
}

beforeEach(() => {
  vi.clearAllMocks()
  proposeMock.mockResolvedValue({ items: [] })
  listAssetsMock.mockResolvedValue([])
  registerCarrying({}, {})
})

describe('developmentFundFigures', () => {
  it('moves a year\'s capitalisation to the fund', () => {
    expect(developmentFundFigures({ openingCarrying: 0, carryingAmount: 100_000, capitalised: 100_000 }, 0)).toMatchObject({
      writtenOff: 0,
      toFund: 100_000,
      fromFund: 0,
      excess: 0,
    })
  })

  it('moves exactly the year\'s write-offs back, and shows both gross when both happen', () => {
    // 100 000 at the start, 20 000 written off this year, 50 000 new.
    const figures = developmentFundFigures({ openingCarrying: 100_000, carryingAmount: 130_000, capitalised: 50_000 }, 100_000)
    expect(figures).toMatchObject({ writtenOff: 20_000, toFund: 50_000, fromFund: 20_000, excess: 0 })
    expect(developmentFundLines(figures, '2091').map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2091', 50_000, 0],
      ['2089', 0, 50_000],
      ['2089', 20_000, 0],
      ['2091', 0, 20_000],
    ])
  })

  it('catches a fund up that earlier years never set', () => {
    expect(developmentFundFigures({ openingCarrying: 240_000, carryingAmount: 240_000, capitalised: 0 }, 0)).toMatchObject({
      toFund: 240_000,
      fromFund: 0,
    })
  })

  it('never releases what the fund held beyond the own development', () => {
    expect(developmentFundFigures({ openingCarrying: 0, carryingAmount: 0, capitalised: 0 }, 400_000)).toMatchObject({
      toFund: 0,
      fromFund: 0,
      excess: 400_000,
    })
  })
})

describe('buildDevelopmentFundProposal', () => {
  it('does not apply to a form without a fund or a K2 year', async () => {
    const { supabase } = client()
    expect(await buildDevelopmentFundProposal(supabase as never, 'co', 'fy', 'enskild_firma')).toBeNull()
    const k2 = createTableMockSupabase({ companies: { data: { accounting_framework: 'k2' } } })
    expect(await buildDevelopmentFundProposal(k2.supabase as never, 'co', 'fy', 'aktiebolag')).toBeNull()
  })

  // B1: a K2 year still open while the next year is elected K3 has no fund
  // for own development to follow (K2 forbids capitalising it).
  it('does not apply to a K2 year whose next year is K3', async () => {
    trialBalanceMock.mockResolvedValue({ rows: rows([{ account_number: '2089', opening_credit: 50_000, closing_credit: 50_000 }]) })
    const k2Year = createTableMockSupabase({
      fiscal_period_frameworks: { data: { fiscal_period_id: 'fy', framework: 'k2', source: 'company_default' } },
      companies: { data: { accounting_framework: 'k3', development_expenditure_model: 'capitalise' } },
      fiscal_periods: { data: PERIOD },
    })
    expect(await buildDevelopmentFundProposal(k2Year.supabase as never, 'co', 'fy', 'aktiebolag')).toBeNull()
  })

  it('does not apply with nothing on 1010-1019 and no fund', async () => {
    trialBalanceMock.mockResolvedValue({ rows: rows([{ account_number: '1930', closing_debit: 5_000 }]) })
    expect(await build()).toBeNull()
  })

  // R1, production shape 1: a fund on 2089 and an amount on 101x, no asset in
  // the register (two K3 aktiebolag today).
  it('proposes no release for a fund whose 1010-1019 the register does not hold', async () => {
    trialBalanceMock.mockResolvedValue({
      rows: rows([
        { account_number: '1010', opening_debit: 4_447_558.33, closing_debit: 4_447_558.33 },
        { account_number: '2089', opening_credit: 4_063_818.82, closing_credit: 4_063_818.82 },
      ]),
    })
    const built = await build()
    expect(built?.proposal).toBeNull()
    expect(built?.warning).toMatch(/anläggningsregistret förklarar 0 kr/)
    expect(built?.warning).toMatch(/markera det egna utvecklingsarbetet/)
  })

  // R1, production shape 2: the fund and an asset on 1010 the old default
  // put there, never marked. Before, own carrying 0 released the whole fund.
  it('proposes no release while an asset on 1010-1019 is not marked as own development', async () => {
    trialBalanceMock.mockResolvedValue({
      rows: rows([
        { account_number: '1010', opening_debit: 300_000, closing_debit: 300_000 },
        { account_number: '1019', opening_credit: 60_000, closing_credit: 80_000 },
        { account_number: '2089', opening_credit: 240_000, closing_credit: 240_000 },
      ]),
    })
    listAssetsMock.mockResolvedValue([asset({ id: 'old', name: 'Kundportal', own_development: false })])
    registerCarrying({ old: 240_000 }, { old: 220_000 })
    const built = await build()
    expect(built?.proposal).toBeNull()
    expect(built?.warning).toMatch(/inte är markerade som eget utvecklingsarbete: Kundportal/)
    expect(built?.warning).toMatch(/markera den som eget utvecklingsarbete/)
  })

  it('proposes no release for a fund with no own development in the register at all', async () => {
    trialBalanceMock.mockResolvedValue({
      rows: rows([{ account_number: '2089', opening_credit: 50_000, closing_credit: 50_000 }]),
    })
    const built = await build()
    expect(built?.proposal).toBeNull()
    expect(built?.warning).toMatch(/inget eget utvecklingsarbete/)
  })

  it('releases exactly the year\'s depreciation of a marked asset', async () => {
    trialBalanceMock.mockResolvedValue({
      rows: rows([
        { account_number: '1010', opening_debit: 300_000, closing_debit: 300_000 },
        { account_number: '1019', opening_credit: 60_000, period_credit: 20_000, closing_credit: 80_000 },
        { account_number: '2089', opening_credit: 240_000, closing_credit: 240_000 },
      ]),
    })
    listAssetsMock.mockResolvedValue([asset({ acquisition_cost: 300_000 })])
    registerCarrying({ 'a-1': 240_000 }, { 'a-1': 220_000 })
    const built = await build()
    expect(built?.figures).toMatchObject({ openingCarrying: 240_000, carryingAmount: 220_000, writtenOff: 20_000, toFund: 0, fromFund: 20_000 })
    expect(built?.proposal).toMatchObject({ kind: 'fond_for_utvecklingsutgifter', amount: 20_000, signedAmount: -20_000 })
    expect(built?.proposal?.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2089', 20_000, 0],
      ['2091', 0, 20_000],
    ])
    expect(built?.warning).toBeUndefined()
  })

  it('moves the year\'s capitalisation of a marked asset to the fund', async () => {
    trialBalanceMock.mockResolvedValue({
      rows: rows([{ account_number: '1010', period_debit: 100_000, closing_debit: 100_000 }]),
    })
    listAssetsMock.mockResolvedValue([asset({ acquisition_date: '2026-03-01' })])
    registerCarrying({}, { 'a-1': 100_000 })
    const built = await build()
    expect(built?.proposal).toMatchObject({ amount: 100_000, signedAmount: 100_000 })
    expect(built?.proposal?.lines.map((l) => l.account_number)).toEqual(['2091', '2089'])
  })

  it('keeps a fund larger than the own development, and says so', async () => {
    trialBalanceMock.mockResolvedValue({
      rows: rows([
        { account_number: '1010', opening_debit: 100_000, closing_debit: 100_000 },
        { account_number: '1019', opening_credit: 0, period_credit: 10_000, closing_credit: 10_000 },
        { account_number: '2089', opening_credit: 150_000, closing_credit: 150_000 },
      ]),
    })
    listAssetsMock.mockResolvedValue([asset({})])
    registerCarrying({ 'a-1': 100_000 }, { 'a-1': 90_000 })
    const built = await build()
    // Only the year's 10 000 of depreciation comes back, not the 50 000 excess.
    expect(built?.proposal).toMatchObject({ signedAmount: -10_000 })
    expect(built?.warning).toMatch(/50\s000 kr större/)
  })

  it('proposes nothing again once the year\'s transfer is posted', async () => {
    trialBalanceMock.mockResolvedValue({
      rows: rows([
        { account_number: '1010', opening_debit: 300_000, closing_debit: 300_000 },
        { account_number: '1019', opening_credit: 60_000, period_credit: 20_000, closing_credit: 80_000 },
        { account_number: '2089', opening_credit: 240_000, period_debit: 20_000, closing_credit: 220_000 },
      ]),
    })
    listAssetsMock.mockResolvedValue([asset({ acquisition_cost: 300_000 })])
    registerCarrying({ 'a-1': 240_000 }, { 'a-1': 220_000 })
    const built = await build()
    expect(built?.proposal).toBeNull()
    expect(built?.warning).toBeUndefined()
  })

  it('warns instead of proposing until the aktiveringsmodell is chosen', async () => {
    trialBalanceMock.mockResolvedValue({ rows: rows([{ account_number: '1010', period_debit: 100_000, closing_debit: 100_000 }]) })
    listAssetsMock.mockResolvedValue([asset({ acquisition_date: '2026-03-01' })])
    registerCarrying({}, { 'a-1': 100_000 })
    const built = await build(null)
    expect(built?.proposal).toBeNull()
    expect(built?.warning).toMatch(/aktiveringsmodellen/)
  })

  it('waits for the year\'s depreciation of the own development', async () => {
    trialBalanceMock.mockResolvedValue({ rows: rows([{ account_number: '1010', period_debit: 100_000, closing_debit: 100_000 }]) })
    listAssetsMock.mockResolvedValue([asset({ acquisition_date: '2026-03-01' })])
    registerCarrying({}, { 'a-1': 100_000 })
    proposeMock.mockResolvedValue({
      items: [{ asset: { bas_asset_account: '1010' }, existingJournalEntryId: null }],
    })
    const built = await build()
    expect(built?.proposal).toBeNull()
    expect(built?.warning).toMatch(/avskrivningar/)
  })
})
