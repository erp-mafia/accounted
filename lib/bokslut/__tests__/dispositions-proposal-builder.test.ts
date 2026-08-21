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

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/bolagsskatt-calculator', () => ({
  calculateBolagsskatt: vi.fn(),
  getBookedBolagsskatt: vi.fn(),
  sumPostedYearEndDispositions: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/tax-adjustment-service', () => ({
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
import {
  calculateBolagsskatt,
  getBookedBolagsskatt,
  sumPostedYearEndDispositions,
} from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import { loadTaxAdjustmentSnapshot } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import { calculateSarskildLoneskatt } from '@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator'
import { calculateOveravskrivningar } from '@/lib/bokslut/reserves/overavskrivningar-calculator'
import {
  listExistingPeriodiseringsfonder,
  SchablonintaktRateNotConfiguredError,
} from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { buildDispositionsProposal } from '../dispositions-proposal-builder'

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
    from: vi.fn((table: string) => (table === 'company_settings' ? settingsBuilder : periodBuilder)),
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
  vi.mocked(sumPostedYearEndDispositions).mockResolvedValue({
    total: 0,
    slpPortion: 0,
    taxProvisionPortion: 0,
  })
  vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue({
    items: [],
    nonDeductibleExpenses: 0,
    nonTaxableIncome: 0,
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
  vi.mocked(calculateBolagsskatt).mockResolvedValue(bolagsskattProposal)
})

describe('buildDispositionsProposal: schablonintäkt rate resolution', () => {
  it('builds the FY2024 proposal for an AB without periodiseringsfonder (the Väla Redovisning case)', async () => {
    const supabase = supabaseFor({ period_start: '2024-01-01', period_end: '2024-12-31' })

    const result = await buildDispositionsProposal(supabase, 'company-1', 'period-1')

    expect(result.entityType).toBe('aktiebolag')
    expect(result.proposals.map((p) => p.kind)).toContain('bolagsskatt')
    // Inga fonder: no schablonintäkt reaches the tax base.
    expect(vi.mocked(calculateBolagsskatt)).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      expect.objectContaining({
        manualAdjustments: expect.objectContaining({ schablonintaktPeriodiseringsfond: 0 }),
      }),
    )
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
      supabase,
      'company-1',
      'period-1',
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
