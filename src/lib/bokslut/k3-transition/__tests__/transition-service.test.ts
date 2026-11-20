import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bokslut/assets/building-tax-service', () => ({
  loadBuildingTemporaryDifferences: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/asset-service')>()),
  listAssets: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/transition-split-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/transition-split-service')>()),
  listTransitionSplitCandidates: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/deferred-tax-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/tax-provision/deferred-tax-service')>()),
  deferredTaxBalances: vi.fn(),
}))
// The transition year's own framework (the per-year resolver): K3 here.
const frameworkForYearMock = vi.hoisted(() => vi.fn(async (): Promise<'k2' | 'k3'> => 'k3'))
vi.mock('@/lib/bokslut/framework-for-year', () => ({
  frameworkForYear: frameworkForYearMock,
  frameworkOnDate: vi.fn(async () => 'k3'),
}))
vi.mock('@/lib/company/entity-type', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/entity-type')>()),
  resolveCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

import { K3TransitionBlockedError, K3TransitionInvalidError } from '@/lib/bookkeeping/errors'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { loadBuildingTemporaryDifferences } from '@/lib/bokslut/assets/building-tax-service'
import { listTransitionSplitCandidates } from '@/lib/bokslut/assets/transition-split-service'
import { deferredTaxBalances } from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { previewK3Transition } from '../transition-service'
import type { Asset } from '@/types'

/**
 * The transition voucher before it is posted (K3 35.11): the opening
 * deferred tax on the buildings' differences at the day before the
 * transition and the stated adjustments, all against the form's balanserat
 * resultat, never through the income statement.
 */

const { supabase, enqueueMany, reset } = createQueuedMockSupabase()

const PERIOD = {
  id: 'period-2026',
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

function transitionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'transition-1',
    fiscal_period_id: PERIOD.id,
    deferred_tax_relief: false,
    relief_rules: [],
    changed_principles: '',
    journal_entry_id: null,
    opening_deferred_tax: 0,
    deferred_tax_items: [],
    committed_at: null,
    journal_entry: null,
    ...overrides,
  }
}

const EMPTY = { adjustments: [], loss_carryforward: null, manual_items: [] }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  vi.mocked(loadBuildingTemporaryDifferences).mockResolvedValue([
    { assetId: 'b-1', name: 'Kontorshus', carryingAmount: 880_000, taxValue: 780_000 },
  ])
  vi.mocked(listAssets).mockResolvedValue([
    { id: 'b-2', name: 'Lager', category: 'building', acquisition_date: '2018-01-01', disposed_at: null, tax_depreciation_rate: null } as unknown as Asset,
  ])
  vi.mocked(listTransitionSplitCandidates).mockResolvedValue([])
  vi.mocked(deferredTaxBalances).mockResolvedValue({ liability: 0, asset: 0, openingLiability: 0, openingAsset: 0 })
})

describe('previewK3Transition', () => {
  it('books the opening deferred tax and the adjustments against 2091 on the transition date', async () => {
    enqueueMany([{ data: transitionRow() }, { data: PERIOD }])
    const preview = await previewK3Transition(supabase as never, 'company-1', {
      ...EMPTY,
      adjustments: [{ account_number: '1790', amount: 12_500, description: 'Förutbetald hyra' }],
    })
    // At the transition date, with the plans that reach the first K3 year.
    expect(loadBuildingTemporaryDifferences).toHaveBeenCalledWith(
      supabase,
      'company-1',
      { id: PERIOD.id, period_start: '2025-12-31', period_end: '2025-12-31' },
      { yearStart: '2026-01-01' },
    )
    expect(preview.transition_date).toBe('2026-01-01')
    expect(preview.equity_account).toBe('2091')
    expect(preview.deferred_tax).toMatchObject({ relief: false, opening: 20_600, change: 20_600, held: 0 })
    expect(preview.lines.map((line) => [line.account_number, line.debit_amount, line.credit_amount])).toEqual([
      ['2091', 20_600, 0],
      ['2240', 0, 20_600],
      ['1790', 12_500, 0],
      ['2091', 0, 12_500],
    ])
    expect(preview.warnings.join(' ')).toMatch(/Lager har ingen skattemässig avskrivningsplan/)
  })

  it('books no deferred tax under the 35.27 relief', async () => {
    enqueueMany([{ data: transitionRow({ deferred_tax_relief: true }) }, { data: PERIOD }])
    const preview = await previewK3Transition(supabase as never, 'company-1', EMPTY)
    expect(loadBuildingTemporaryDifferences).not.toHaveBeenCalled()
    expect(preview.deferred_tax).toMatchObject({ relief: true, opening: 0, change: 0, items: [] })
    expect(preview.lines).toEqual([])
  })

  it('refuses a committed transition and an adjustment off the balance sheet', async () => {
    enqueueMany([{ data: transitionRow({ committed_at: '2026-02-01T00:00:00Z' }) }])
    await expect(previewK3Transition(supabase as never, 'company-1', EMPTY)).rejects.toBeInstanceOf(K3TransitionBlockedError)
    reset()
    enqueueMany([{ data: transitionRow() }, { data: PERIOD }])
    await expect(
      previewK3Transition(supabase as never, 'company-1', {
        ...EMPTY,
        adjustments: [{ account_number: '5010', amount: 100, description: 'Hyra' }],
      }),
    ).rejects.toBeInstanceOf(K3TransitionInvalidError)
  })

  it('refuses before the transition is started', async () => {
    enqueueMany([{ data: null }])
    await expect(previewK3Transition(supabase as never, 'company-1', EMPTY)).rejects.toMatchObject({ reason: 'not_started' })
  })
})

describe('previewK3Transition: the year\'s own framework', () => {
  // B1: a year switched back to K2 after the transition began (or a K2 year
  // whose next year is K3) books no K3 transition.
  it('refuses when the transition year is no longer reported under K3', async () => {
    enqueueMany([{ data: transitionRow() }, { data: PERIOD }])
    frameworkForYearMock.mockResolvedValueOnce('k2')
    await expect(previewK3Transition(supabase as never, 'company-1', EMPTY)).rejects.toMatchObject({ reason: 'not_k3' })
    expect(frameworkForYearMock).toHaveBeenCalledWith(supabase, 'company-1', PERIOD.id)
  })
})
