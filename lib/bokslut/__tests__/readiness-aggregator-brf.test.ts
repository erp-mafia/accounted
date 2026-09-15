/**
 * Bostadsrättsförening in the bokslut readiness report: the year's
 * privatbostadsföretag assessment (IL 2 kap. 17 §) is a blocker when
 * missing, an info reminder when äkta, a warning when oäkta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { YearEndValidation } from '@/types'

vi.mock('@/lib/core/bookkeeping/year-end-service', () => ({
  validateYearEndReadiness: vi.fn(),
}))
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(),
}))
vi.mock('@/lib/reports/ar-reconciliation', () => ({
  generateARReconciliation: vi.fn(),
}))
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/reports/supplier-reconciliation', () => ({
  generateReconciliation: vi.fn(),
}))
vi.mock('@/lib/company/brf-tax-profile', () => ({
  getTaxProfile: vi.fn(),
}))

import { buildBokslutReadinessReport } from '../readiness-aggregator'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { generateReconciliation as generateAPReconciliation } from '@/lib/reports/supplier-reconciliation'
import { getTaxProfile } from '@/lib/company/brf-tax-profile'

function makeSupabase(entityType: string) {
  function builder(table: string) {
    const b = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
    }
    b.select.mockReturnValue(b)
    b.eq.mockReturnValue(b)
    if (table === 'fiscal_periods') {
      b.single.mockResolvedValue({
        data: {
          id: 'fp-1',
          name: '2026',
          period_start: '2026-01-01',
          period_end: '2026-12-31',
          is_closed: false,
          locked_at: null,
          closing_entry_id: null,
        },
        error: null,
      })
    } else if (table === 'company_settings') {
      b.maybeSingle.mockResolvedValue({ data: { entity_type: entityType, accounting_method: 'accrual' }, error: null })
    } else if (table === 'cash_accounts') {
      b.maybeSingle.mockResolvedValue({
        data: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', currency: 'SEK', is_primary: true, ledger_account: '1930' },
        error: null,
      })
    } else {
      b.maybeSingle.mockResolvedValue({ data: null, error: null })
    }
    return b
  }
  return { from: vi.fn((table: string) => builder(table)) } as unknown as Parameters<
    typeof buildBokslutReadinessReport
  >[0]
}

const VALIDATION: YearEndValidation = {
  ready: true,
  blockers: [],
  errors: [],
  warnings: [],
  draftCount: 0,
  voucherGaps: [],
  unexplainedGaps: [],
  sequenceMismatches: [],
  trialBalanceBalanced: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(validateYearEndReadiness).mockResolvedValue(VALIDATION)
  vi.mocked(getReconciliationStatus).mockResolvedValue({
    bank_transaction_total: 0,
    gl_1930_balance: 0,
    gl_1930_period_movement: 0,
    gl_1930_opening_balance: 0,
    difference: 0,
    is_reconciled: true,
    matched_count: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  } as never)
  vi.mocked(generateARReconciliation).mockResolvedValue({
    ar_ledger_total: 0,
    account_1510_balance: 0,
    difference: 0,
    is_reconciled: true,
    unconverted_fx_count: 0,
  })
  vi.mocked(generateAPReconciliation).mockResolvedValue({
    supplier_ledger_total: 0,
    account_2440_balance: 0,
    difference: 0,
    is_reconciled: true,
    unconverted_fx_count: 0,
  })
})

describe('buildBokslutReadinessReport: bostadsrättsförening', () => {
  it('blocks the bokslut when the taxation year is unassessed', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue(null)
    const report = await buildBokslutReadinessReport(makeSupabase('bostadsrattsforening'), 'co', 'u', 'fp-1')
    expect(vi.mocked(getTaxProfile)).toHaveBeenCalledWith(expect.anything(), 'co', 2026)
    expect(report.ready).toBe(false)
    expect(report.blockerItems.some((b) => b.code === 'BRF_TAX_PROFILE_MISSING')).toBe(true)
    expect(report.blockers.some((m) => m.includes('IL 2 kap. 17 §'))).toBe(true)
    expect(report.reminders.find((r) => r.code === 'brf_tax_profile_missing')?.severity).toBe('warning')
  })

  it('explains the exemption for an äkta year without blocking', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue({ privatbostadsforetag: true } as never)
    const report = await buildBokslutReadinessReport(makeSupabase('bostadsrattsforening'), 'co', 'u', 'fp-1')
    expect(report.ready).toBe(true)
    expect(report.blockerItems).toEqual([])
    const akta = report.reminders.find((r) => r.code === 'brf_akta')
    expect(akta?.severity).toBe('info')
    expect(akta?.message).toContain('IL 39 kap. 25 §')
    expect(akta?.message).toContain('IL 30 kap.')
  })

  it('warns about uttagsbeskattning and KU31 for an oäkta year', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue({ privatbostadsforetag: false } as never)
    const report = await buildBokslutReadinessReport(makeSupabase('bostadsrattsforening'), 'co', 'u', 'fp-1')
    expect(report.ready).toBe(true)
    const oakta = report.reminders.find((r) => r.code === 'brf_oakta')
    expect(oakta?.severity).toBe('warning')
    expect(oakta?.message).toContain('KU31')
    expect(oakta?.message).toContain('IL 22 kap.')
  })

  it('reports a failed profile read as a warning, never as a pass', async () => {
    vi.mocked(getTaxProfile).mockRejectedValue(new Error('boom'))
    const report = await buildBokslutReadinessReport(makeSupabase('bostadsrattsforening'), 'co', 'u', 'fp-1')
    expect(report.reminders.find((r) => r.code === 'brf_tax_profile_check_failed')).toBeDefined()
    expect(report.reminders.find((r) => r.code === 'brf_akta')).toBeUndefined()
  })

  it('never consults the profile for an ekonomisk förening', async () => {
    const report = await buildBokslutReadinessReport(makeSupabase('ekonomisk_forening'), 'co', 'u', 'fp-1')
    expect(vi.mocked(getTaxProfile)).not.toHaveBeenCalled()
    expect(report.ready).toBe(true)
  })
})
