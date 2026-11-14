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
// The EF declaration preview refuses every form but the NE filer itself; the
// aggregator must only call it for that form, with the form it resolved.
vi.mock('@/lib/bokslut/enskild-firma/ef-declaration-preview', () => ({
  computeEfDeclarationPreview: vi.fn(),
}))

import { buildBokslutReadinessReport } from '../readiness-aggregator'
import { computeEfDeclarationPreview } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { generateReconciliation as generateAPReconciliation } from '@/lib/reports/supplier-reconciliation'

const CASH_ACCOUNT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

interface MockBuilder {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  or: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
}

const NO_ROWS = { data: [], error: null }

function makeSupabase(handlers: {
  period: { data: unknown; error: unknown }
  settings: { data: unknown; error: unknown }
  cashAccount?: { data: unknown; error: unknown }
  /** journal_entries with source_type 'import' in the period (id-only, limit 1). */
  importedEntries?: { data: unknown; error: unknown }
  /** Completed sie_imports for the period (id-only, limit 1). */
  sieImports?: { data: unknown; error: unknown }
}) {
  function makeBuilder(table: string): MockBuilder {
    const b: MockBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      limit: vi.fn(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
    }
    b.select.mockReturnValue(b)
    b.eq.mockReturnValue(b)
    b.or.mockReturnValue(b)
    if (table === 'journal_entries') {
      b.limit.mockResolvedValue(handlers.importedEntries ?? NO_ROWS)
    } else if (table === 'sie_imports') {
      b.limit.mockResolvedValue(handlers.sieImports ?? NO_ROWS)
    } else if (table === 'fiscal_periods') {
      b.single.mockResolvedValue(handlers.period)
    } else if (table === 'company_settings') {
      b.maybeSingle.mockResolvedValue(handlers.settings)
    } else if (table === 'companies') {
      // Canonical NOT NULL fallback read by resolveCompanyEntityType when the
      // settings row is missing; never a guessed default.
      b.maybeSingle.mockResolvedValue({ data: { entity_type: 'aktiebolag' }, error: null })
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
  as_of_date: null,
  account_1510_balance: 0,
  difference: 0,
  is_reconciled: true,
  unconverted_fx_count: 0,
}

const AP_CLEAN = {
  supplier_ledger_total: 0,
  as_of_date: null,
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
  it('returns a ready report without static reminders for AB', async () => {
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
    // Reminders are this year's findings only: the static accruals guidance
    // lives behind the Periodiseringar step's "?", and depreciation,
    // bolagsskatt and p-fond have their own calculators. A clean year has none.
    expect(report.reminders).toEqual([])
    expect(report.reminders.map((r) => r.code)).not.toContain('accruals_manual')
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

  it('returns the kapitalunderlag reminder but no static NE reminder for enskild firma', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN)
    vi.mocked(computeEfDeclarationPreview).mockResolvedValue({
      fiscalPeriod: PERIOD,
      bookedSurplus: 80_000,
      items: [],
      pfondFonder: [],
      rutor: {
        R29: 80_000,
        R30: 0,
        R31: 0,
        R32: 0,
        R33: 80_000,
        R34: 0,
        R35: 80_000,
        R36: 0,
        R37: 0,
        R40: 0,
        R41: 0,
        R42: 80_000,
        R43: 20_000,
      },
      ovrigaUppgifter: [],
      warnings: [],
    })
    const supabase = makeSupabase({
      period: { data: PERIOD, error: null },
      settings: { data: { entity_type: 'enskild_firma' }, error: null },
    })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.entityType).toBe('enskild_firma')
    // The "beräknas i NE-bilagan, inte bokförs" text is static guidance: it
    // lives behind the Dispositioner step's "?", not in every report.
    expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeUndefined()
    // The preview runs for the NE filer with the form the aggregator resolved.
    expect(computeEfDeclarationPreview).toHaveBeenCalledWith(supabase, 'co-1', 'fp-1', {
      entityType: 'enskild_firma',
    })
    expect(report.reminders.find((r) => r.code === 'ef_kapitalunderlag_missing')).toBeDefined()
  })

  it.each(['aktiebolag', 'ideell_forening'])(
    'never computes the EF declaration preview for %s',
    async (entityType) => {
      vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
      // Cast: RECON_CLEAN predates two ReconciliationStatus fields; the
      // suite's older cases carry that as a baselined type error and this
      // case must not add another instance.
      vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
      const supabase = makeSupabase({
        period: { data: PERIOD, error: null },
        settings: { data: { entity_type: entityType }, error: null },
      })

      const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

      expect(report.entityType).toBe(entityType)
      expect(computeEfDeclarationPreview).not.toHaveBeenCalled()
      expect(report.reminders.find((r) => r.code === 'ef_skatt_via_ne')).toBeUndefined()
    },
  )

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

  it.each([
    ['no row for this company', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }],
    ['an id that is no uuid', { code: '22P02', message: 'invalid input syntax for type uuid: "undefined"' }],
  ])('refuses with PERIOD_NOT_FOUND when the fiscal period is missing: %s', async (_name, error) => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN)
    const supabase = makeSupabase({
      period: { data: null, error },
      settings: { data: null, error: null },
    })

    await expect(
      buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-missing'),
    ).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND', message: 'Fiscal period not found' })
  })

  it('a period read that failed is a failure, not a missing period', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
    const supabase = makeSupabase({
      period: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      settings: { data: null, error: null },
    })

    const failure = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1').catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/read failed.*statement timeout/)
    expect((failure as { code?: string }).code).toBeUndefined()
  })

  it('falls back to companies.entity_type when company_settings is missing', async () => {
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

describe('imported history (klarmarkera prompt)', () => {
  const ab = { data: { entity_type: 'aktiebolag' }, error: null }

  beforeEach(() => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue(baseValidation())
    vi.mocked(getReconciliationStatus).mockResolvedValue(RECON_CLEAN as never)
  })

  it('is false for a year with no imported verifikat and no SIE import', async () => {
    const supabase = makeSupabase({ period: { data: PERIOD, error: null }, settings: ab })

    const report = await buildBokslutReadinessReport(supabase, 'co-1', 'user-1', 'fp-1')

    expect(report.holdsImportedHistory).toBe(false)
    // Both reads are scoped to this company and this period.
    const from = vi.mocked(supabase.from)
    const entriesBuilder = from.mock.results[from.mock.calls.findIndex(([t]) => t === 'journal_entries')]
      .value as MockBuilder
    expect(entriesBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1')
    expect(entriesBuilder.eq).toHaveBeenCalledWith('fiscal_period_id', 'fp-1')
    expect(entriesBuilder.eq).toHaveBeenCalledWith('source_type', 'import')
    expect(entriesBuilder.limit).toHaveBeenCalledWith(1)
    const importsBuilder = from.mock.results[from.mock.calls.findIndex(([t]) => t === 'sie_imports')]
      .value as MockBuilder
    expect(importsBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1')
    expect(importsBuilder.eq).toHaveBeenCalledWith('fiscal_period_id', 'fp-1')
    expect(importsBuilder.eq).toHaveBeenCalledWith('status', 'completed')
    expect(importsBuilder.or).toHaveBeenCalledWith('job_state.is.null,and(job_state.eq.completed,job_kind.eq.import)')
  })

  it('is true when the period holds an imported verifikat', async () => {
    const report = await buildBokslutReadinessReport(
      makeSupabase({
        period: { data: PERIOD, error: null },
        settings: ab,
        importedEntries: { data: [{ id: 'je-1' }], error: null },
      }),
      'co-1',
      'user-1',
      'fp-1',
    )

    expect(report.holdsImportedHistory).toBe(true)
  })

  it('is true for a balances-only SIE import with no verifikat', async () => {
    const report = await buildBokslutReadinessReport(
      makeSupabase({
        period: { data: PERIOD, error: null },
        settings: ab,
        sieImports: { data: [{ id: 'imp-1' }], error: null },
      }),
      'co-1',
      'user-1',
      'fp-1',
    )

    expect(report.holdsImportedHistory).toBe(true)
  })

  it('degrades to false without failing the report when the reads fail', async () => {
    const report = await buildBokslutReadinessReport(
      makeSupabase({
        period: { data: PERIOD, error: null },
        settings: ab,
        importedEntries: { data: null, error: { message: 'timeout' } },
        sieImports: { data: null, error: { message: 'timeout' } },
      }),
      'co-1',
      'user-1',
      'fp-1',
    )

    expect(report.holdsImportedHistory).toBe(false)
    expect(report.ready).toBe(true)
  })
})
