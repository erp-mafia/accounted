/**
 * buildDispositionsProposal: the shared core of GET /bokslutsdispositioner
 * and the MCP preview tool. These tests pin the schablonintäkt rate
 * behaviour that broke every pre-2025 bokslut in production: the SLR table
 * only had 2025/2026, and the builder consulted it unconditionally, so a
 * räkenskapsår 2024 AB with no periodiseringsfonder at all got a generic 500
 * at step 3 of the wizard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExistingFond } from '../reserves/periodiseringsfond-service'

// These cases are K2 years: the year's framework (the per-year resolver) is K2.
vi.mock('@/lib/bokslut/framework-for-year', () => ({
  frameworkForYear: vi.fn(async () => 'k2'),
  frameworkOnDate: vi.fn(async () => 'k2'),
}))
vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/bolagsskatt-calculator', () => ({
  calculateBolagsskatt: vi.fn(),
  getBookedBolagsskatt: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/result-before-tax', () => ({
  readYearResult: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/tax-adjustment-service', () => ({
  // INK2S 4.9 (lib/bokslut/assets/building-tax-service): no buildings here.
  loadBuildingTaxAdjustment: vi.fn(async () => ({ net: 0, lines: [], warnings: [] })),
  loadTaxAdjustmentSnapshot: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator', () => ({
  calculateSarskildLoneskatt: vi.fn(),
}))
vi.mock('@/lib/bokslut/reserves/overavskrivningar-calculator', () => ({
  calculateOveravskrivningar: vi.fn(),
}))
vi.mock('@/lib/bokslut/reserves/periodiseringsfond-service', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/bokslut/reserves/periodiseringsfond-service')
  >()
  return { ...actual, listExistingPeriodiseringsfonder: vi.fn() }
})

import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { calculateBolagsskatt, getBookedBolagsskatt } from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import { readYearResult } from '@/lib/bokslut/tax-provision/result-before-tax'
import { loadTaxAdjustmentSnapshot } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import { calculateSarskildLoneskatt } from '@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator'
import { calculateOveravskrivningar } from '@/lib/bokslut/reserves/overavskrivningar-calculator'
import {
  listExistingPeriodiseringsfonder,
  SchablonintaktRateNotConfiguredError,
} from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { buildDispositionsProposal, dividendConfirmationWarning } from '../dispositions-proposal-builder'
import type { TaxAdjustmentItem, TaxAdjustmentSnapshot } from '../types'

function supabaseFor(period: { period_start: string; period_end: string }, entityType = 'aktiebolag') {
  const periodBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue({
      data: {
        id: 'period-1',
        name: `Räkenskapsår ${period.period_end.slice(0, 4)}`,
        period_start: period.period_start,
        period_end: period.period_end,
        opening_balance_entry_id: null,
      },
      error: null,
    }),
  }
  periodBuilder.select.mockReturnValue(periodBuilder)
  periodBuilder.eq.mockReturnValue(periodBuilder)
  const settingsBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { entity_type: entityType }, error: null }),
  }
  settingsBuilder.select.mockReturnValue(settingsBuilder)
  settingsBuilder.eq.mockReturnValue(settingsBuilder)
  return {
    // companies is the canonical fallback resolveCompanyEntityType reads
    // when the settings hint is not a known form; it answers the same.
    from: vi.fn((table: string) =>
      table === 'company_settings' || table === 'companies' ? settingsBuilder : periodBuilder,
    ),
  } as unknown as SupabaseClient
}

const fond2120 = (opening_balance: number): ExistingFond => ({
  account_number: '2120',
  cohort_year: 2020,
  balance: opening_balance,
  opening_balance,
  must_return_this_year: false,
})

const bolagsskattProposal = {
  kind: 'bolagsskatt' as const,
  label: 'Bolagsskatt 20,6 %',
  description: 'Skatt på årets skattemässiga resultat.',
  amount: 20_600,
  lines: [
    { account_number: '8910', debit_amount: 20_600, credit_amount: 0 },
    { account_number: '2512', debit_amount: 0, credit_amount: 20_600 },
  ],
  warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateIncomeStatement).mockResolvedValue({
    net_result: 100_000,
  } as Awaited<ReturnType<typeof generateIncomeStatement>>)
  vi.mocked(readYearResult).mockResolvedValue({ beforeDispositions: 100_000, beforeTax: 100_000 })
  vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue({
    items: [],
    nonDeductibleExpenses: 0,
    nonTaxableIncome: 0,
    deficitCarryforward: 0,
  })
  vi.mocked(getBookedBolagsskatt).mockResolvedValue(0)
  vi.mocked(listExistingPeriodiseringsfonder).mockResolvedValue([])
  vi.mocked(calculateOveravskrivningar).mockResolvedValue({
    status: 'not_applicable',
    proposal: null,
    currentReserve: 0,
    currentPeriodChange: 0,
    targetReserve: 0,
    maximumSignedChange: 0,
  })
  vi.mocked(calculateSarskildLoneskatt).mockResolvedValue(null)
  vi.mocked(calculateBolagsskatt).mockReturnValue(bolagsskattProposal)
})

describe('buildDispositionsProposal: schablonintäkt rate resolution', () => {
  it('builds the FY2024 proposal for an AB without periodiseringsfonder (the reported case)', async () => {
    const supabase = supabaseFor({ period_start: '2024-01-01', period_end: '2024-12-31' })

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.entityType).toBe('aktiebolag')
    expect(result.proposals.map((p) => p.kind)).toContain('bolagsskatt')
    // Inga fonder: no schablonintäkt reaches the tax base.
    expect(vi.mocked(calculateBolagsskatt)).toHaveBeenCalledWith(
      expect.objectContaining({
        manualAdjustments: expect.objectContaining({ schablonintaktPeriodiseringsfond: 0 }),
      }),
    )
  })

  it('builds the same juridisk-person proposal for an ekonomisk förening (IL 65 kap. 10 §)', async () => {
    const supabase = supabaseFor(
      { period_start: '2024-01-01', period_end: '2024-12-31' },
      'ekonomisk_forening',
    )

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.entityType).toBe('ekonomisk_forening')
    expect(result.proposals.map((p) => p.kind)).toContain('bolagsskatt')
    expect(vi.mocked(calculateBolagsskatt)).toHaveBeenCalled()
  })

  it('returns no dispositions for an ideell förening (INK3, income mostly tax-exempt under IL 7 kap.)', async () => {
    const supabase = supabaseFor(
      { period_start: '2024-01-01', period_end: '2024-12-31' },
      'ideell_forening',
    )

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.entityType).toBe('ideell_forening')
    expect(result.proposals).toEqual([])
    expect(vi.mocked(calculateBolagsskatt)).not.toHaveBeenCalled()
  })

  it('does not consult the SLR table for a no-fond company even on an unmapped closing year', async () => {
    const supabase = supabaseFor({ period_start: '2019-01-01', period_end: '2019-12-31' })

    await expect(
      buildDispositionsProposal(supabase, 'company-1', 'period-1'),
    ).resolves.toMatchObject({ entityType: 'aktiebolag' })
  })

  it('folds the closing-year SLR into the tax base when fonder carried an opening balance', async () => {
    vi.mocked(listExistingPeriodiseringsfonder).mockResolvedValue([fond2120(100_000)])
    const supabase = supabaseFor({ period_start: '2024-01-01', period_end: '2024-12-31' })

    await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    // 100 000 × 2.62 % (SLR 2023-11-30) = 2 620 kr schablonintäkt, INK2S 4.6a.
    expect(vi.mocked(calculateBolagsskatt)).toHaveBeenCalledWith(
      expect.objectContaining({
        manualAdjustments: expect.objectContaining({ schablonintaktPeriodiseringsfond: 2_620 }),
      }),
    )
  })

  it('fails closed with the typed registry error when fonder exist and the year is unmapped', async () => {
    vi.mocked(listExistingPeriodiseringsfonder).mockResolvedValue([fond2120(100_000)])
    const supabase = supabaseFor({ period_start: '2019-01-01', period_end: '2019-12-31' })

    await expect(
      buildDispositionsProposal(supabase, 'company-1', 'period-1'),
    ).rejects.toBeInstanceOf(SchablonintaktRateNotConfiguredError)
  })
})

describe('buildDispositionsProposal: forms without corporate tax dispositions', () => {
  // The gate is the profile capability, not the form name: a förening used
  // to fall into the same branch as an enskild firma only by accident of
  // `!== 'aktiebolag'`, and the wizard then showed it the NE-bilaga section.
  it.each(['enskild_firma', 'ideell_forening'] as const)(
    'returns no proposals and computes no bolagsskatt for %s',
    async (entityType) => {
      const supabase = supabaseFor({ period_start: '2025-01-01', period_end: '2025-12-31' }, entityType)

      const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

      expect(result.entityType).toBe(entityType)
      expect(result.proposals).toEqual([])
      expect(result.netResultBefore).toBe(100_000)
      expect(result.taxAdjustments).toBeUndefined()
      expect(vi.mocked(calculateBolagsskatt)).not.toHaveBeenCalled()
      expect(vi.mocked(calculateOveravskrivningar)).not.toHaveBeenCalled()
    },
  )

  it('refuses a form the registry does not know instead of defaulting it', async () => {
    const supabase = supabaseFor({ period_start: '2025-01-01', period_end: '2025-12-31' }, 'handelsbolag')

    await expect(buildDispositionsProposal(supabase, 'company-1', 'period-1')).rejects.toThrow(
      /Unknown company entity_type/,
    )
  })
})

describe('buildDispositionsProposal: the result the declaration reads', () => {
  it('shows the year before dispositions and rests the cap and the tax on the year before tax', async () => {
    // readYearResult: 120 000 before dispositions, 15 000 of återföring booked.
    vi.mocked(readYearResult).mockResolvedValue({ beforeDispositions: 120_000, beforeTax: 135_000 })
    const supabase = supabaseFor({ period_start: '2025-01-01', period_end: '2025-12-31' })

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.netResultBefore).toBe(120_000)
    // The periodiseringsfond cap is 25 % of the base, and the bolagsskatt
    // base is the same result after the avsättning.
    const avsattning = result.proposals.find((p) => p.kind === 'periodiseringsfond_avsattning')
    expect(avsattning?.amount).toBe(33_750)
    expect(vi.mocked(calculateBolagsskatt)).toHaveBeenCalledWith(
      expect.objectContaining({ resultBeforeTax: 135_000 - 33_750 }),
    )
  })

  it('warns when the booked tax no longer matches the base, a stock count booked after it', async () => {
    vi.mocked(readYearResult).mockResolvedValue({ beforeDispositions: 60_000, beforeTax: 60_000 })
    vi.mocked(getBookedBolagsskatt).mockResolvedValue(20_600)
    vi.mocked(calculateBolagsskatt).mockReturnValue({ ...bolagsskattProposal, amount: 12_360 })
    const supabase = supabaseFor({ period_start: '2025-01-01', period_end: '2025-12-31' })

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.completedDispositions).toEqual([
      expect.objectContaining({ kind: 'bolagsskatt', amount: 20_600, status: 'needs_correction' }),
    ])
  })
})

/**
 * crm#1688 (accounted#180): a first AB year with a small profit, where the
 * proposed maximum överavskrivning turns the result into a loss. The preview's
 * bolagsskatt was 0 kr with nothing on screen saying why, a hand-booked tax
 * was "wrong" against proposals not booked yet, and skipping the överavskrivning
 * left no bolagsskatt card to book the tax with.
 */
describe('buildDispositionsProposal: a 0 kr bolagsskatt the proposals cause', () => {
  const overavskrivning = {
    kind: 'overavskrivningar' as const,
    label: 'Förändring av överavskrivningar',
    description: 'Överavskrivning enligt 30-regeln.',
    amount: 10_959,
    signedAmount: 10_959,
    lines: [],
    warnings: [],
  }

  beforeEach(async () => {
    const actual = await vi.importActual<
      typeof import('@/lib/bokslut/tax-provision/bolagsskatt-calculator')
    >('@/lib/bokslut/tax-provision/bolagsskatt-calculator')
    vi.mocked(calculateBolagsskatt).mockImplementation(actual.calculateBolagsskatt)
    vi.mocked(readYearResult).mockResolvedValue({ beforeDispositions: 9_112.36, beforeTax: 9_112.36 })
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue({
      items: [],
      nonDeductibleExpenses: 480,
      nonTaxableIncome: 0,
      deficitCarryforward: 0,
    })
    vi.mocked(calculateOveravskrivningar).mockResolvedValue({
      status: 'ready',
      proposal: overavskrivning,
      currentReserve: 0,
      currentPeriodChange: 0,
      targetReserve: 10_959,
      maximumSignedChange: 10_959,
    })
  })

  const period = { period_start: '2025-06-24', period_end: '2026-06-30' }

  it('names the proposal that zeroes the tax, and the tax on the ledger as it stands', async () => {
    const result = await buildDispositionsProposal(supabaseFor(period), 'company-1', 'period-1')

    expect(result.taxBasis).toEqual({
      bookedResultBeforeTax: 9_112.36,
      pending: [{ kind: 'overavskrivningar', label: 'Förändring av överavskrivningar', resultEffect: -10_959 }],
      taxWithProposals: 0,
      // floor10(9 112,36 + 480) = 9 590; 9 590 x 20,6 % = 1 975,54.
      taxAsBooked: 1_976,
      // The one proposal that takes the 1 976 kr to 0 kr, and what it takes off the result.
      zeroedBy: [{ kind: 'overavskrivningar', label: 'Förändring av överavskrivningar', resultEffect: -10_959 }],
    })
  })

  it('names every proposal that lowers the result, never an återföring that raises it', async () => {
    // A mandatory återföring (+1 000) and an SLP (-500) beside the överavskrivning.
    vi.mocked(listExistingPeriodiseringsfonder).mockResolvedValue([
      { ...fond2120(1_000), must_return_this_year: true },
    ])
    vi.mocked(calculateSarskildLoneskatt).mockResolvedValue({
      kind: 'sarskild_loneskatt',
      label: 'Särskild löneskatt',
      description: 'Särskild löneskatt på pensionskostnader.',
      amount: 500,
      lines: [],
      warnings: [],
    })

    const result = await buildDispositionsProposal(supabaseFor(period), 'company-1', 'period-1')

    expect(result.taxBasis?.pending.map((p) => p.kind)).toEqual([
      'periodiseringsfond_ateforing',
      'overavskrivningar',
      'sarskild_loneskatt',
    ])
    expect(result.taxBasis?.taxWithProposals).toBe(0)
    expect(result.taxBasis?.zeroedBy).toEqual([
      { kind: 'overavskrivningar', label: 'Förändring av överavskrivningar', resultEffect: -10_959 },
      { kind: 'sarskild_loneskatt', label: 'Särskild löneskatt', resultEffect: -500 },
    ])
    const tax = result.proposals.find((p) => p.kind === 'bolagsskatt')
    // formatCurrency spaces are non-breaking: \s matches them.
    expect(tax?.description).toMatch(
      /Förändring av överavskrivningar \(-10\s959\skr\), Särskild löneskatt \(-500\skr\)/,
    )
    expect(tax?.description).not.toContain('Återföring')
    // The mandatory återföring is pending, so the ledger's tax is not what
    // skipping the överavskrivning gives: no figure, but the överavskrivning
    // can still be skipped.
    expect(tax?.description).not.toContain('Utan dem')
    expect(tax?.description).toContain('avmarkera dem')
  })

  it('offers no skip when only a tax owed (SLP) zeroes it', async () => {
    vi.mocked(calculateOveravskrivningar).mockResolvedValue({
      status: 'not_applicable',
      proposal: null,
      currentReserve: 0,
      currentPeriodChange: 0,
      targetReserve: 0,
      maximumSignedChange: 0,
    })
    vi.mocked(calculateSarskildLoneskatt).mockResolvedValue({
      kind: 'sarskild_loneskatt',
      label: 'Särskild löneskatt',
      description: 'Särskild löneskatt på pensionskostnader.',
      amount: 9_600,
      lines: [],
      warnings: [],
    })

    const result = await buildDispositionsProposal(supabaseFor(period), 'company-1', 'period-1')

    expect(result.taxBasis?.zeroedBy.map((p) => p.kind)).toEqual(['sarskild_loneskatt'])
    const tax = result.proposals.find((p) => p.kind === 'bolagsskatt')
    expect(tax?.description).toMatch(/Särskild löneskatt \(-9\s600\skr\)/)
    expect(tax?.description).not.toContain('Utan dem')
    expect(tax?.description).not.toContain('avmarkera')
  })

  it('still offers the bolagsskatt card, so skipping the överavskrivning books the tax', async () => {
    const result = await buildDispositionsProposal(supabaseFor(period), 'company-1', 'period-1')

    const tax = result.proposals.find((p) => p.kind === 'bolagsskatt')
    expect(tax?.amount).toBe(0)
    expect(tax?.description).toContain('Förändring av överavskrivningar (-10 959 kr)')
    // The tax the ledger carries without it: the amount the 0 kr hides.
    expect(tax?.description).toMatch(/Utan dem blir skatten 1\s976\skr\./)
    expect(tax?.description).toContain('avmarkera dem')
    expect(tax?.description).not.toMatch(/[\u2013\u2014]/)
    // The tax math is unchanged: the card's computation is the preview's.
    expect(tax?.computation).toEqual(expect.objectContaining({ taxAmount: 0 }))
  })

  it('explains a hand-booked tax with both figures and the way out', async () => {
    vi.mocked(getBookedBolagsskatt).mockResolvedValue(2_431)

    const result = await buildDispositionsProposal(supabaseFor(period), 'company-1', 'period-1')

    expect(result.proposals.find((p) => p.kind === 'bolagsskatt')).toBeUndefined()
    const [booked] = result.completedDispositions ?? []
    expect(booked).toEqual(expect.objectContaining({ kind: 'bolagsskatt', status: 'needs_correction' }))
    const warning = booked.warnings[0]
    expect(warning).toContain('Bokförd skatt är 2 431 kr')
    expect(warning).toContain('skatten blir 0 kr om de föreslagna dispositionerna bokförs')
    expect(warning).toContain('Förändring av överavskrivningar (-10 959 kr)')
    expect(warning).toContain('Utan dem blir skatten 1 976 kr')
    expect(warning).toContain('Storna verifikationen med den bokförda skatten')
    expect(warning).not.toMatch(/[–—]/)
  })

  it('offers no bolagsskatt card in a loss year, where nothing carries tax', async () => {
    vi.mocked(readYearResult).mockResolvedValue({ beforeDispositions: -5_000, beforeTax: -5_000 })

    const result = await buildDispositionsProposal(supabaseFor(period), 'company-1', 'period-1')

    expect(result.proposals.find((p) => p.kind === 'bolagsskatt')).toBeUndefined()
    expect(result.taxBasis?.taxAsBooked).toBe(0)
    // The ledger carries no tax, so no proposal is what zeroes it.
    expect(result.taxBasis?.zeroedBy).toEqual([])
  })

  it('keeps the plain bolagsskatt card when the tax stays above 0 kr', async () => {
    vi.mocked(readYearResult).mockResolvedValue({ beforeDispositions: 100_000, beforeTax: 100_000 })

    const result = await buildDispositionsProposal(supabaseFor(period), 'company-1', 'period-1')

    const tax = result.proposals.find((p) => p.kind === 'bolagsskatt')
    expect(tax?.amount).toBeGreaterThan(0)
    expect(tax?.description).not.toContain('avmarkera')
    // Lowered, not zeroed: the pending list still carries the överavskrivning.
    expect(result.taxBasis?.pending.map((p) => p.kind)).toContain('overavskrivningar')
    expect(result.taxBasis?.zeroedBy).toEqual([])
  })
})

/**
 * crm#1726: a holding AB whose result is a dividend on 8210. The dividend is
 * taxed until the user confirms the shares are näringsbetingade, and the
 * proposal says so; once confirmed (with the prior year's underskott), a tax
 * base at or below zero gets neither a periodiseringsfond nor bolagsskatt.
 */
describe('buildDispositionsProposal: dividends on shares (crm#1726)', () => {
  const dividend = (included: boolean): TaxAdjustmentItem => ({
    sourceKey: 'account:8210',
    source: 'detected',
    adjustmentType: 'non_taxable_income',
    description: 'Utdelningar på andelar i andra företag, skattefri om andelarna är näringsbetingade',
    accountNumber: '8210',
    amount: 100_000,
    included,
    needsConfirmation: true,
  })
  const manualNonTaxable = (amount: number): TaxAdjustmentItem => ({
    sourceKey: 'manual:non_taxable_income',
    source: 'manual',
    adjustmentType: 'non_taxable_income',
    description: 'Ej skattepliktiga intäkter',
    accountNumber: null,
    amount,
    included: amount > 0,
  })
  const snapshot = (items: TaxAdjustmentItem[], deficitCarryforward = 0): TaxAdjustmentSnapshot => ({
    items,
    nonDeductibleExpenses: 0,
    nonTaxableIncome: items
      .filter((i) => i.adjustmentType === 'non_taxable_income' && i.included)
      .reduce((sum, i) => sum + i.amount, 0),
    deficitCarryforward,
  })

  it('asks about an unconfirmed dividend and names the account and the rule', () => {
    const warning = dividendConfirmationWarning(snapshot([dividend(false)]))
    expect(warning).toContain('konto 8210')
    expect(warning).toContain('IL 24 kap. 35 §')
    expect(warning).toContain('Skattemässiga justeringar')
  })

  it('stays silent once the dividend is confirmed, or typed in by hand', () => {
    expect(dividendConfirmationWarning(snapshot([dividend(true)]))).toBeNull()
    expect(dividendConfirmationWarning(snapshot([dividend(false), manualNonTaxable(100_000)]))).toBeNull()
    expect(dividendConfirmationWarning(snapshot([dividend(false), manualNonTaxable(40_000)]))).not.toBeNull()
    expect(dividendConfirmationWarning(snapshot([]))).toBeNull()
  })

  it('puts the question in the proposal while the dividend is still taxed', async () => {
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(snapshot([dividend(false)]))
    const supabase = supabaseFor({ period_start: '2025-01-01', period_end: '2025-12-31' })

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.warnings?.some((w) => w.includes('konto 8210'))).toBe(true)
    // Unconfirmed, the proposal is unchanged: the dividend is in the base.
    expect(result.proposals.find((p) => p.kind === 'periodiseringsfond_avsattning')?.amount).toBe(25_000)
  })

  it('proposes neither periodiseringsfond nor bolagsskatt when the confirmed base is below zero', async () => {
    const actual = await vi.importActual<
      typeof import('@/lib/bokslut/tax-provision/bolagsskatt-calculator')
    >('@/lib/bokslut/tax-provision/bolagsskatt-calculator')
    vi.mocked(calculateBolagsskatt).mockImplementation(actual.calculateBolagsskatt)
    vi.mocked(readYearResult).mockResolvedValue({ beforeDispositions: 98_000, beforeTax: 98_000 })
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(snapshot([dividend(true)], 2_000))
    const supabase = supabaseFor({ period_start: '2025-01-01', period_end: '2025-12-31' })

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.warnings?.some((w) => w.includes('konto 8210'))).toBe(false)
    expect(result.proposals.map((p) => p.kind)).not.toContain('periodiseringsfond_avsattning')
    expect(result.proposals.map((p) => p.kind)).not.toContain('bolagsskatt')
    expect(result.taxBasis?.taxAsBooked).toBe(0)
  })
})
