import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { YearEndValidation } from '@/types'

// Mock both sources the aggregator composes from. Tests focus on composition
// (reminders by entity, reconciliation surfacing, error tolerance): the
// underlying validateYearEndReadiness already has its own coverage.
vi.mock('@/lib/core/bookkeeping/year-end-service', () => ({
  validateYearEndReadiness: vi.fn(),
}))

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(),
}))

import { buildBokslutReadinessReport } from '../readiness-aggregator'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'

interface MockBuilder {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
}

function makeSupabase(handlers: {
  period: { data: unknown; error: unknown }
  settings: { data: unknown; error: unknown }
}) {
  function makeBuilder(table: string): MockBuilder {
    const b: MockBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
    }
    b.select.mockReturnValue(b)
    b.eq.mockReturnValue(b)
    if (table === 'fiscal_periods') {
      b.single.mockResolvedValue(handlers.period)
    } else if (table === 'company_settings') {
      b.maybeSingle.mockResolvedValue(handlers.settings)
    }
    return b
  }
  return {
    from: vi.fn((table: string) => makeBuilder(table)),
  } as unknown as Parameters<typeof buildBokslutReadinessReport>[0]
}

function baseValidation(overrides: Partial<YearEndValidation> = {}): YearEndValidation {
  return {
    ready: true,
    errors: [],
    warnings: [],
    draftCount: 0,
    voucherGaps: [],
    unexplainedGaps: [],
    sequenceMismatches: [],
    trialBalanceBalanced: true,
    ...overrides,
  }
}

const PERIOD = {
  id: 'fp-1',
  name: '2025',
  period_start: '2025-01-01',
  period_end: '2025-12-31',
  is_closed: false,
  locked_at: null,
  closing_entry_id: null,
}

const RECON_CLEAN = {
  bank_transaction_total: 100,
  gl_1930_balance: 100,
  gl_1930_period_movement: 100,
  gl_1930_opening_balance: 0,
  difference: 0,
  is_reconciled: true,
  matched_count: 5,
  unmatched_transaction_count: 0,
  unmatched_gl_line_count: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildBokslutReadinessReport', () => {
  it('returns a ready report with the accruals reminder for AB', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN)
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.entityType).toBe('aktiebolag')
    // Phase 3 handles depreciation + bolagsskatt + p-fond automatically: only
    // the accruals reminder should remain (Phase 4 will replace it).
    expect(report.reminders.map((r) => r.code)).toContain('accruals_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('depreciation_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('bolagsskatt_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('periodiseringsfond_manual')
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeUndefined()
    expect(report.reconciliation?.is_reconciled).toBe(true)
  })

  it('returns the EF-only reminder for enskild firma', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN)
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'enskild_firma' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.entityType).toBe('enskild_firma')
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeDefined()
  })

  it('surfaces blockers from the underlying validation and stays not-ready', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(
      baseValidation({
        ready: false,
        errors: ['3 draft journal entries must be posted or deleted before closing'],
        draftCount: 3,
      }),
    )
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN)
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(false)
    expect(report.blockers).toHaveLength(1)
    expect(report.draftCount).toBe(3)
  })

  it('adds a reconciliation reminder when bank is unreconciled', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue({
      ...RECON_CLEAN,
      is_reconciled: false,
      unmatched_transaction_count: 7,
      difference: 1234.56,
    })
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    const reconReminder = report.reminders.find((r) => r.code === 'bank_reconciliation_incomplete')
    expect(reconReminder).toBeDefined()
    expect(reconReminder?.severity).toBe('warning')
    expect(reconReminder?.message).toContain('7')
    // Reconciliation reminder is not a legal blocker: ready should still mirror validation
    expect(report.ready).toBe(true)
  })

  it('does not break when reconciliation lookup throws', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockRejectedValue(new Error('boom'))
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.reconciliation).toBeNull()
    expect(report.reminders.find((r) => r.code === 'bank_reconciliation_incomplete')).toBeUndefined()
    expect(report.ready).toBe(true)
  })

  it('throws when the fiscal period is missing', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN)
    const supabase = makeSupabase({
      period: { data: null, error: { message: 'not found' } },
      settings: { data: null, error: null },
    })

    await expect(
      buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-missing'),
    ).rejects.toThrow(/not found/i)
  })

  it('defaults to aktiebolag when company_settings is missing', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN)
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: null, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.entityType).toBe('aktiebolag')
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeUndefined()
  })
})
