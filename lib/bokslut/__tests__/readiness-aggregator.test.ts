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

vi.mock('@/lib/reports/ar-reconciliation', () => ({
  generateARReconciliation: vi.fn(),
}))

const listAccountsMock = vi.fn()
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: (...args: unknown[]) => listAccountsMock(...args),
}))
vi.mock('@/lib/reports/supplier-reconciliation', () => ({
  generateReconciliation: vi.fn(),
}))

import { buildBokslutReadinessReport } from '../readiness-aggregator'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { generateReconciliation as generateAPReconciliation } from '@/lib/reports/supplier-reconciliation'

const CASH_ACCOUNT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

interface MockBuilder {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
}

function makeSupabase(handlers: {
  period: { data: unknown; error: unknown }
  settings: { data: unknown; error: unknown }
  cashAccount?: { data: unknown; error: unknown }
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
    } else if (table === 'cash_accounts') {
      // The aggregator resolves 1930 to its cash_accounts row so the bank total
      // is scoped to that account (#1290).
      b.maybeSingle.mockResolvedValue(
        handlers.cashAccount ?? {
          data: {
            id: CASH_ACCOUNT_ID,
            currency: 'SEK',
            is_primary: true,
            ledger_account: '1930',
          },
          error: null,
        },
      )
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
    blockers: [],
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

const AR_CLEAN = {
  ar_ledger_total: 0,
  account_1510_balance: 0,
  difference: 0,
  is_reconciled: true,
  unconverted_fx_count: 0,
}

const AP_CLEAN = {
  supplier_ledger_total: 0,
  account_2440_balance: 0,
  difference: 0,
  is_reconciled: true,
  unconverted_fx_count: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: clean tie-outs. Individual tests override to simulate mismatches.
  vi.mocked(generateARReconciliation).mockResolvedValue(AR_CLEAN)
  vi.mocked(generateAPReconciliation).mockResolvedValue(AP_CLEAN)
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
    expect(report.blockerItems).toEqual([])
    expect(report.entityType).toBe('aktiebolag')
    // Phase 3 handles depreciation + bolagsskatt + p-fond automatically: only
    // the accruals reminder should remain (Phase 4 will replace it).
    expect(report.reminders.map((r) => r.code)).toContain('accruals_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('depreciation_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('bolagsskatt_manual')
    expect(report.reminders.map((r) => r.code)).not.toContain('periodiseringsfond_manual')
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeUndefined()
    expect(report.reconciliation?.is_reconciled).toBe(true)
    // Scoped to the resolved 1930 cash account: a 4-arg call left cashAccountId
    // undefined, so the bank side pooled every SEK account while the GL side
    // stayed on 1930 and the wizard showed a differens with nothing to match
    // (#1290).
    expect(vi.mocked(getReconciliationStatus)).toHaveBeenCalledWith(
      supabase,
      'co-1',
      '2025-01-01',
      '2025-12-31',
      '1930',
      'SEK',
      CASH_ACCOUNT_ID,
      true,
    )
  })

  it('drops the reconciliation snapshot when the cash-account lookup fails', async () => {
    // resolveCashAccountScope fails CLOSED. The aggregator's catch must turn
    // that into "no snapshot" rather than into an unscoped 4-arg call, which is
    // the pooling path that produced #1290's phantom differens.
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    // getReconciliationStatus is deliberately left un-stubbed: it must never be
    // reached, and an unstubbed mock resolving to undefined would break the
    // report if it were.
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag' }, error: null },
      cashAccount: { data: null, error: { code: '57014', message: 'canceling statement' } },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.reconciliation).toBeNull()
    expect(vi.mocked(getReconciliationStatus)).not.toHaveBeenCalled()
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
        blockers: [
          { code: 'DRAFT_ENTRIES', message: '3 utkast måste bokföras eller raderas innan bokslut' },
        ],
        errors: ['3 utkast måste bokföras eller raderas innan bokslut'],
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
    // The code+message pairs pass through untouched so the wizard can match
    // remediation links on the stable code.
    expect(report.blockerItems).toEqual([
      { code: 'DRAFT_ENTRIES', message: '3 utkast måste bokföras eller raderas innan bokslut' },
    ])
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

  it('surfaces AR and AP tie-out mismatches as warning reminders for accrual companies', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
    vi.mocked(generateARReconciliation).mockResolvedValue({
      ...AR_CLEAN,
      ar_ledger_total: 25000,
      account_1510_balance: 20000,
      difference: 5000,
      is_reconciled: false,
    })
    vi.mocked(generateAPReconciliation).mockResolvedValue({
      ...AP_CLEAN,
      is_reconciled: false,
      unconverted_fx_count: 2,
    })
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag', accounting_method: 'accrual' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    const ar = report.reminders.find((r) => r.code === 'ar_reconciliation_mismatch')
    expect(ar?.severity).toBe('warning')
    expect(ar?.message).toContain('5000.00 kr')
    expect(ar?.href).toBe('/reports/kundreskontra')
    const ap = report.reminders.find((r) => r.code === 'ap_reconciliation_mismatch')
    expect(ap?.severity).toBe('warning')
    // Unconvertible FX rows make the difference figure unreliable: the message
    // must say the tie-out could not run, not report a phantom difference.
    expect(ap?.message).toContain('saknar valutakurs')
    expect(ap?.href).toBe('/reports/supplier-ledger')
    // Warnings never flip readiness.
    expect(report.ready).toBe(true)
    expect(vi.mocked(generateARReconciliation)).toHaveBeenCalledWith(supabase, 'co-1', 'fp-1')
  })

  it('skips the AR/AP tie-outs entirely for kontantmetoden companies', async () => {
    // Under the cash method open invoices are deliberately not on 1510/2440,
    // so the tie-out is permanently unreconciled by construction and would
    // only mislead.
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'enskild_firma', accounting_method: 'cash' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(vi.mocked(generateARReconciliation)).not.toHaveBeenCalled()
    expect(vi.mocked(generateAPReconciliation)).not.toHaveBeenCalled()
    expect(report.reminders.find((r) => r.code === 'ar_reconciliation_mismatch')).toBeUndefined()
    expect(report.reminders.find((r) => r.code === 'ap_reconciliation_mismatch')).toBeUndefined()
  })

  it('degrades gracefully when a tie-out query fails', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
    vi.mocked(generateARReconciliation).mockRejectedValue(new Error('boom'))
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag', accounting_method: 'accrual' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(true)
    expect(report.reminders.find((r) => r.code === 'ar_reconciliation_mismatch')).toBeUndefined()
    // The AP side still ran and reported clean independently of the AR failure.
    expect(vi.mocked(generateAPReconciliation)).toHaveBeenCalled()
  })
  it('passes through the legal kontantmetoden cut-off blocker from core readiness', async () => {
    const message =
      '2 obetalda fakturor var utestående vid periodens slut. Förhandsgranska och bokför kontantmetodens bokslutsavgränsning.'
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ...baseValidation(),
      ready: false,
      blockers: [{ code: 'KONTANTMETOD_CUTOFF_REQUIRED', message }],
      errors: [message],
    })
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'enskild_firma', accounting_method: 'cash' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.ready).toBe(false)
    expect(report.blockerItems).toContainEqual({
      code: 'KONTANTMETOD_CUTOFF_REQUIRED', message,
    })
  })

  it('keeps faktureringsmetoden reconciliation behavior unchanged', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
    vi.mocked(generateARReconciliation).mockResolvedValue({ is_reconciled: true, difference: 0, unconverted_fx_count: 0 } as never)
    vi.mocked(generateAPReconciliation).mockResolvedValue({ is_reconciled: true, difference: 0, unconverted_fx_count: 0 } as never)
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'aktiebolag', accounting_method: 'accrual' }, error: null },
    })

    await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')
    expect(vi.mocked(generateARReconciliation)).toHaveBeenCalled()
    expect(vi.mocked(generateAPReconciliation)).toHaveBeenCalled()
  })
})

describe('bokslutsbilagor reminder', () => {
  beforeEach(() => {
    listAccountsMock.mockReset()
  })

  it('counts balance accounts not signed off per balansdagen and links to the pärm', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    listAccountsMock.mockResolvedValue([
      { account_key: 'bank:1', kind: 'bank', superseded_by: null, signed_off_through: '2025-12-31' },
      { account_key: 'bank:2', kind: 'bank', superseded_by: 'bank:1', signed_off_through: null },
      { account_key: 'manual:1510', kind: 'manual', superseded_by: null, signed_off_through: '2025-11-30' },
      { account_key: 'manual:2350', kind: 'manual', superseded_by: null, signed_off_through: null },
    ])
    const report = await buildBokslutReadinessReport(
      makeSupabase({ period: { data: PERIOD, error: null }, settings: { data: { entity_type: 'aktiebolag' }, error: null } }),
      'company-1',
      'user-1',
      'fp-1',
    )
    const reminder = report.reminders.find((r) => r.code === 'bilagor_unsigned')
    expect(reminder).toMatchObject({ severity: 'warning', href: '/reports/bokslutsbilagor' })
    expect(reminder?.message).toMatch(/2 av 3 balanskonton/)
    expect(listAccountsMock).toHaveBeenCalledWith(expect.anything(), 'company-1', expect.objectContaining({ withStatus: false, windowTo: PERIOD.period_end }))
  })

  it('says so when every account is signed, and stays silent when the read fails', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    listAccountsMock.mockResolvedValue([{ account_key: 'bank:1', kind: 'bank', superseded_by: null, signed_off_through: '2025-12-31' }])
    const done = await buildBokslutReadinessReport(
      makeSupabase({ period: { data: PERIOD, error: null }, settings: { data: { entity_type: 'aktiebolag' }, error: null } }),
      'company-1',
      'user-1',
      'fp-1',
    )
    expect(done.reminders.find((r) => r.code === 'bilagor_unsigned')).toMatchObject({ severity: 'info' })

    listAccountsMock.mockRejectedValue(new Error('down'))
    const failed = await buildBokslutReadinessReport(
      makeSupabase({ period: { data: PERIOD, error: null }, settings: { data: { entity_type: 'aktiebolag' }, error: null } }),
      'company-1',
      'user-1',
      'fp-1',
    )
    expect(failed.reminders.find((r) => r.code === 'bilagor_unsigned')).toBeUndefined()
  })
})
