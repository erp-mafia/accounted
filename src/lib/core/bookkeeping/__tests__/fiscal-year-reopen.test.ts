import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { CannotReverseNonPostedError } from '@/lib/bookkeeping/errors'
import type { FiscalYearReopenEntry } from '@/types'

const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
}))

const ensureTicSnapshotMock = vi.fn()
const DEPS = { refreshRegistry: () => ensureTicSnapshotMock() }

const resolveEntityTypeMock = vi.fn()
vi.mock('@/lib/company/entity-type', async () => {
  const actual = await vi.importActual<typeof import('@/lib/company/entity-type')>('@/lib/company/entity-type')
  return { ...actual, resolveCompanyEntityType: (...args: unknown[]) => resolveEntityTypeMock(...args) }
})

import { eventBus } from '@/lib/events'
import {
  getFiscalYearReopenEligibility,
  reopenClosedFiscalYear,
} from '../fiscal-year-reopen'

const PERIOD = {
  id: 'fp-2025',
  name: '2025/2026',
  period_start: '2025-05-01',
  period_end: '2026-04-30',
  closing_entry_id: 'je-closing',
}

const ENTRIES: FiscalYearReopenEntry[] = [
  { id: 'je-omforing', kind: 'result_appropriation', voucher_series: 'A', voucher_number: 9, entry_date: '2026-05-01', fiscal_period_id: 'fp-2026' },
  { id: 'je-ib', kind: 'opening_balance', voucher_series: 'A', voucher_number: 8, entry_date: '2026-05-01', fiscal_period_id: 'fp-2026' },
  { id: 'je-closing', kind: 'closing_entry', voucher_series: 'A', voucher_number: 43, entry_date: '2026-04-30', fiscal_period_id: 'fp-2025' },
]

function eligible(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    eligible: true,
    blockers: [],
    resume: false,
    period: PERIOD,
    next_period: { id: 'fp-2026', name: '2026/2027' },
    entries: ENTRIES,
    annual_report: { versions_to_supersede: 1, pending_signatures: 1, agm_date: null },
    registry: { fetched_at: '2026-10-18T00:00:00Z', reports: 2 },
    ...overrides,
  }
}

const REGISTRY_BLOCKED = eligible({ eligible: false, blockers: [{ code: 'registry_unavailable' }] })

const CONFIRM = { confirmName: '2025/2026', confirmNotAdopted: true }

let emitSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined as never)
  resolveEntityTypeMock.mockResolvedValue('aktiebolag')
  reverseEntryMock.mockResolvedValue({ id: 'storno' })
  ensureTicSnapshotMock.mockResolvedValue({ snapshot: {}, source: 'fetched' })
})

describe('getFiscalYearReopenEligibility', () => {
  it('passes the database gate through when the registry is usable, without a TIC fetch', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: eligible() })

    const result = await getFiscalYearReopenEligibility(supabase as never, 'company-1', 'fp-2025', DEPS)

    expect(result).toMatchObject({ ok: true, eligibility: { eligible: true, entries: ENTRIES } })
    expect(ensureTicSnapshotMock).not.toHaveBeenCalled()
    expect(supabase.rpc).toHaveBeenCalledWith('get_fiscal_year_reopen_eligibility', {
      p_company_id: 'company-1',
      p_period_id: 'fp-2025',
    })
  })

  it('refreshes the TIC snapshot when the registry is the blocker, and reads the gate again', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: REGISTRY_BLOCKED })
    enqueue({ data: eligible() })

    const result = await getFiscalYearReopenEligibility(supabase as never, 'company-1', 'fp-2025', DEPS)

    expect(ensureTicSnapshotMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, eligibility: { eligible: true } })
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('stays closed when the refresh fails: the registry blocker remains', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: REGISTRY_BLOCKED })
    ensureTicSnapshotMock.mockRejectedValue(new Error('Lens quota'))

    const result = await getFiscalYearReopenEligibility(supabase as never, 'company-1', 'fp-2025', DEPS)

    expect(result).toMatchObject({
      ok: true,
      eligibility: { eligible: false, blockers: [{ code: 'registry_unavailable' }] },
    })
  })

  it('adds form_not_supported for a form without an årsredovisning', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: eligible() })
    resolveEntityTypeMock.mockResolvedValue('enskild_firma')

    const result = await getFiscalYearReopenEligibility(supabase as never, 'company-1', 'fp-2025', DEPS)

    expect(result).toMatchObject({
      ok: true,
      eligibility: { eligible: false, blockers: [{ code: 'form_not_supported' }] },
    })
  })

  it('maps the database refusals and a failed call', async () => {
    const forbidden = createQueuedMockSupabase()
    forbidden.enqueue({ data: { ok: false, code: 'FISCAL_YEAR_REOPEN_FORBIDDEN' } })
    expect(await getFiscalYearReopenEligibility(forbidden.supabase as never, 'company-1', 'fp-2025', DEPS)).toEqual({
      ok: false,
      code: 'FISCAL_YEAR_REOPEN_FORBIDDEN',
    })

    const failed = createQueuedMockSupabase()
    failed.enqueue({ error: { message: 'boom' } })
    expect(await getFiscalYearReopenEligibility(failed.supabase as never, 'company-1', 'fp-2025', DEPS)).toEqual({
      ok: false,
      code: 'FISCAL_YEAR_REOPEN_FAILED',
    })
  })
})

describe('reopenClosedFiscalYear', () => {
  function happyQueue(overrides: { reopen?: Record<string, unknown>; period?: Record<string, unknown> } = {}) {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: eligible() }) // gate
    mock.enqueue({
      data: {
        ok: true,
        period_name: '2025/2026',
        resumed: false,
        closing_entry_id: 'je-closing',
        entries: ENTRIES,
        next_period_id: 'fp-2026',
        superseded_version_ids: ['v-1'],
        voided_signature_request_ids: ['s-1'],
        ...overrides.reopen,
      },
    })
    mock.enqueue({ data: null }) // detach closing_entry_id
    mock.enqueue({ data: { id: 'fp-2025', name: '2025/2026', is_closed: false, closing_entry_id: null, ...overrides.period } })
    return mock
  }

  it('reopens: the RPC, the stornos in order, the detach, the event', async () => {
    const mock = happyQueue()

    const result = await reopenClosedFiscalYear(mock.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(result).toEqual({
      ok: true,
      periodName: '2025/2026',
      resumed: false,
      reversed: ENTRIES,
      supersededVersions: 1,
    })
    expect(mock.supabase.rpc).toHaveBeenCalledWith('reopen_closed_fiscal_year', {
      p_company_id: 'company-1',
      p_period_id: 'fp-2025',
      p_confirmed_name: '2025/2026',
      p_confirm_not_adopted: true,
    })
    expect(reverseEntryMock.mock.calls.map((c) => c[3])).toEqual(['je-omforing', 'je-ib', 'je-closing'])
    expect(reverseEntryMock).toHaveBeenCalledWith(mock.supabase, 'company-1', 'owner-1', 'je-closing')
    expect(mock.findCall('fiscal_periods', 'update')).toEqual([{ closing_entry_id: null }])
    expect(mock.findCalls('fiscal_periods', 'eq')).toContainEqual(['closing_entry_id', 'je-closing'])
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'period.unlocked' }))
  })

  it("reverses the revaluation's återföring in the next year, and leaves the previous year's standing (accounted#58)", async () => {
    const revaluation: FiscalYearReopenEntry = { id: 'je-reval', kind: 'currency_revaluation', voucher_series: 'A', voucher_number: 42, entry_date: '2026-04-30', fiscal_period_id: 'fp-2025' }
    // The återföring the previous year's close posted into this year.
    const previous: FiscalYearReopenEntry = { id: 'je-prev-return', kind: 'currency_revaluation', voucher_series: 'A', voucher_number: 1, entry_date: '2025-05-01', fiscal_period_id: 'fp-2025' }
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: eligible() }) // gate
    mock.enqueue({
      data: {
        ok: true,
        period_name: '2025/2026',
        resumed: false,
        closing_entry_id: 'je-closing',
        entries: [...ENTRIES, previous, revaluation],
        next_period_id: 'fp-2026',
        superseded_version_ids: [],
      },
    })
    mock.enqueue({ data: [{ id: 'je-prev-return', source_id: 'je-prev-reval' }, { id: 'je-reval', source_id: null }] })
    mock.enqueue({ data: [{ id: 'je-return', voucher_series: 'A', voucher_number: 10, entry_date: '2026-05-01', fiscal_period_id: 'fp-2026' }] })
    mock.enqueue({ data: null }) // detach closing_entry_id
    mock.enqueue({ data: { id: 'fp-2025', name: '2025/2026', is_closed: false, closing_entry_id: null } })

    const result = await reopenClosedFiscalYear(mock.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(result).toMatchObject({ ok: true })
    expect(reverseEntryMock.mock.calls.map((c) => c[3])).toEqual(['je-omforing', 'je-ib', 'je-return', 'je-closing', 'je-reval'])
    expect(mock.findCalls('journal_entries', 'in')).toEqual([
      ['id', ['je-prev-return', 'je-reval']],
      ['source_id', ['je-reval']],
    ])
  })

  it('refuses a form without an årsredovisning before touching the database', async () => {
    const { supabase } = createQueuedMockSupabase()
    resolveEntityTypeMock.mockResolvedValue('enskild_firma')

    const result = await reopenClosedFiscalYear(supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(result).toEqual({
      ok: false,
      code: 'FISCAL_YEAR_REOPEN_INELIGIBLE',
      blockers: [{ code: 'form_not_supported' }],
    })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('passes the database refusals through and posts nothing', async () => {
    for (const refusal of [
      { ok: false, code: 'FISCAL_YEAR_REOPEN_INELIGIBLE', blockers: [{ code: 'annual_report_signed' }] },
      { ok: false, code: 'FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED' },
      { ok: false, code: 'FISCAL_YEAR_REOPEN_CONFIRMATION_MISMATCH' },
      { ok: false, code: 'FISCAL_YEAR_REOPEN_FORBIDDEN' },
    ]) {
      reverseEntryMock.mockClear()
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: eligible() })
      enqueue({ data: refusal })

      const result = await reopenClosedFiscalYear(supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

      expect(result).toMatchObject({ ok: false, code: refusal.code })
      expect(reverseEntryMock).not.toHaveBeenCalled()
    }
  })

  it('answers FAILED for an unknown refusal or a failed call', async () => {
    const unknown = createQueuedMockSupabase()
    unknown.enqueue({ data: eligible() })
    unknown.enqueue({ data: { ok: false, code: 'SOMETHING_ELSE' } })
    expect(await reopenClosedFiscalYear(unknown.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS))
      .toMatchObject({ ok: false, code: 'FISCAL_YEAR_REOPEN_FAILED' })

    const failed = createQueuedMockSupabase()
    failed.enqueue({ data: eligible() })
    failed.enqueue({ error: { message: 'boom' } })
    expect(await reopenClosedFiscalYear(failed.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS))
      .toMatchObject({ ok: false, code: 'FISCAL_YEAR_REOPEN_FAILED' })
  })

  it('refreshes the registry before the reopen when it is the blocker', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: REGISTRY_BLOCKED })
    mock.enqueue({ data: eligible() })
    mock.enqueue({ data: { ok: true, period_name: '2025/2026', resumed: false, closing_entry_id: 'je-closing', entries: ENTRIES } })
    mock.enqueue({ data: null })
    mock.enqueue({ data: { id: 'fp-2025', name: '2025/2026', is_closed: false, closing_entry_id: null } })

    const result = await reopenClosedFiscalYear(mock.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(ensureTicSnapshotMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true })
  })

  it('resumes: a verifikat already reversed is skipped, the rest go on', async () => {
    const mock = happyQueue({ reopen: { resumed: true } })
    reverseEntryMock
      .mockRejectedValueOnce(new CannotReverseNonPostedError('reversed'))
      .mockResolvedValue({ id: 'storno' })

    const result = await reopenClosedFiscalYear(mock.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(result).toMatchObject({ ok: true, resumed: true })
    expect((result as { reversed: FiscalYearReopenEntry[] }).reversed.map((e) => e.id)).toEqual(['je-ib', 'je-closing'])
  })

  it('stops as INCOMPLETE when a storno fails, and does not detach', async () => {
    const mock = happyQueue()
    reverseEntryMock
      .mockResolvedValueOnce({ id: 'storno-1' })
      .mockRejectedValueOnce(new Error('accounts missing'))

    const result = await reopenClosedFiscalYear(mock.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(result).toEqual({ ok: false, code: 'FISCAL_YEAR_REOPEN_INCOMPLETE', stoppedAt: 'A8' })
    expect(mock.findCall('fiscal_periods', 'update')).toBeUndefined()
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('stops as INCOMPLETE when the detach is refused', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: eligible() })
    mock.enqueue({ data: { ok: true, period_name: '2025/2026', resumed: false, closing_entry_id: 'je-closing', entries: ENTRIES } })
    mock.enqueue({ error: { message: 'year-end closing is immutable' } })

    const result = await reopenClosedFiscalYear(mock.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(result).toEqual({ ok: false, code: 'FISCAL_YEAR_REOPEN_INCOMPLETE', stoppedAt: 'closing_entry_id' })
  })

  it('stops as INCOMPLETE when the year does not read as open afterwards', async () => {
    const mock = happyQueue({ period: { is_closed: true } })

    const result = await reopenClosedFiscalYear(mock.supabase as never, 'company-1', 'fp-2025', 'owner-1', CONFIRM, DEPS)

    expect(result).toEqual({ ok: false, code: 'FISCAL_YEAR_REOPEN_INCOMPLETE', stoppedAt: 'verify' })
    expect(emitSpy).not.toHaveBeenCalled()
  })
})
