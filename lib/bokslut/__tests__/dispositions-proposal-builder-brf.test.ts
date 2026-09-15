/**
 * buildDispositionsProposal for a bostadsrättsförening: no bolagsskatt is
 * proposed until the year's privatbostadsföretag assessment exists; an
 * äkta year taxes the residue the adjustment items leave; an oäkta year
 * warns about uttagsbeskattning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  const actual = await importOriginal<typeof import('@/lib/bokslut/reserves/periodiseringsfond-service')>()
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
import { listExistingPeriodiseringsfonder } from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { buildDispositionsProposal } from '../dispositions-proposal-builder'
import type { TaxAdjustmentSnapshot } from '../types'

function supabaseFor() {
  const periodBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue({
      data: {
        id: 'period-1',
        name: 'Räkenskapsår 2026',
        period_start: '2026-01-01',
        period_end: '2026-12-31',
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
    maybeSingle: vi.fn().mockResolvedValue({ data: { entity_type: 'bostadsrattsforening' }, error: null }),
  }
  settingsBuilder.select.mockReturnValue(settingsBuilder)
  settingsBuilder.eq.mockReturnValue(settingsBuilder)
  return {
    from: vi.fn((table: string) => (table === 'company_settings' ? settingsBuilder : periodBuilder)),
  } as unknown as SupabaseClient
}

function snapshot(brf: TaxAdjustmentSnapshot['brf'], totals = { nonDeductibleExpenses: 0, nonTaxableIncome: 0 }): TaxAdjustmentSnapshot {
  return { items: [], ...totals, brf }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateIncomeStatement).mockResolvedValue({ net_result: 12_000 } as never)
  vi.mocked(sumPostedYearEndDispositions).mockResolvedValue({ total: 0, slpPortion: 0, taxProvisionPortion: 0 })
  vi.mocked(getBookedBolagsskatt).mockResolvedValue(0)
  vi.mocked(listExistingPeriodiseringsfonder).mockResolvedValue([])
  vi.mocked(calculateSarskildLoneskatt).mockResolvedValue(null)
  vi.mocked(calculateOveravskrivningar).mockResolvedValue({
    status: 'ready',
    proposal: null,
    warning: null,
    currentPeriodChange: 0,
  } as never)
  vi.mocked(calculateBolagsskatt).mockResolvedValue({
    kind: 'bolagsskatt',
    label: 'Bolagsskatt 20,6 %',
    description: '',
    amount: 2_472,
    lines: [],
    warnings: [],
  } as never)
})

describe('buildDispositionsProposal: bostadsrättsförening', () => {
  it('proposes no bolagsskatt and warns when the year is unassessed', async () => {
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
      snapshot({ taxationYear: 2026, status: 'unassessed', propertyIncome: 0, propertyCosts: 0, taxableCapitalIncome: 0 }),
    )
    const result = await buildDispositionsProposal(supabaseFor(), 'co', 'period-1')
    expect(vi.mocked(calculateBolagsskatt)).not.toHaveBeenCalled()
    expect(result.proposals.some((p) => p.kind === 'bolagsskatt')).toBe(false)
    expect(result.warnings?.some((w) => w.includes('IL 2 kap. 17 §') && w.includes('2026'))).toBe(true)
  })

  it('taxes the residue of an äkta year through the adjustment totals', async () => {
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
      snapshot(
        { taxationYear: 2026, status: 'akta', propertyIncome: 2_400_000, propertyCosts: 1_700_000, taxableCapitalIncome: 12_000 },
        { nonDeductibleExpenses: 1_700_000, nonTaxableIncome: 2_400_000 },
      ),
    )
    const result = await buildDispositionsProposal(supabaseFor(), 'co', 'period-1')
    expect(vi.mocked(calculateBolagsskatt)).toHaveBeenCalledWith(
      expect.anything(),
      'co',
      'period-1',
      expect.objectContaining({
        manualAdjustments: expect.objectContaining({ nonDeductibleExpenses: 1_700_000, nonTaxableIncome: 2_400_000 }),
      }),
    )
    expect(result.proposals.some((p) => p.kind === 'bolagsskatt')).toBe(true)
    expect(result.warnings?.some((w) => w.includes('IL 39 kap. 25 §'))).toBe(true)
  })

  it('warns about uttagsbeskattning and KU31 for an oäkta year and still proposes tax', async () => {
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
      snapshot({ taxationYear: 2026, status: 'oakta', propertyIncome: 0, propertyCosts: 0, taxableCapitalIncome: 12_000 }),
    )
    const result = await buildDispositionsProposal(supabaseFor(), 'co', 'period-1')
    expect(result.proposals.some((p) => p.kind === 'bolagsskatt')).toBe(true)
    expect(result.warnings?.some((w) => w.includes('KU31') && w.includes('4.6e'))).toBe(true)
  })
})
