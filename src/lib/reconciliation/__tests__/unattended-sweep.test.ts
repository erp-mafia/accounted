/**
 * Tests for the per-cash-account unattended reconciliation sweep (issue #1298).
 *
 * The sweep is the shared entry point for every unattended caller (EB cron,
 * manual EB sync, bank-file import). What matters here is the fan-out contract:
 * one scoped runReconciliation call per enabled cash account, the legacy
 * 1930/SEK fallback for companies with no cash_accounts rows, per-account
 * failure isolation, and honest aggregation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { runReconciliationMock } = vi.hoisted(() => ({
  runReconciliationMock: vi.fn(),
}))

vi.mock('../bank-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bank-reconciliation')>()
  return {
    ...actual,
    runReconciliation: runReconciliationMock,
  }
})

import { runUnattendedReconciliationSweep, toSweepSummary } from '../unattended-sweep'
import { DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD } from '../bank-reconciliation'

function emptyRunResult(overrides: Partial<{
  applied: number
  errors: number
  skippedBelowThreshold: number
  suggested: number
  candidates: number
  matches: unknown[]
}> = {}) {
  return {
    matches: overrides.matches ?? [],
    applied: overrides.applied ?? 0,
    errors: overrides.errors ?? 0,
    skippedBelowThreshold: overrides.skippedBelowThreshold ?? 0,
    suggested: overrides.suggested ?? 0,
    candidates: overrides.candidates ?? 0,
  }
}

/** Chainable stub for the cash_accounts lookup: every method returns the chain,
 *  awaiting it resolves the configured result. */
function makeSupabase(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(result)
      }
      return () => new Proxy(chain, handler)
    },
  }
  return {
    from: vi.fn().mockImplementation(() => new Proxy(chain, handler)),
  }
}

const CA_1930 = {
  id: '11111111-1111-4111-8111-111111111111',
  ledger_account: '1930',
  currency: 'SEK',
  is_primary: true,
}
const CA_1931 = {
  id: '22222222-2222-4222-8222-222222222222',
  ledger_account: '1931',
  currency: 'SEK',
  is_primary: false,
}
const CA_1932_EUR = {
  id: '33333333-3333-4333-8333-333333333333',
  ledger_account: '1932',
  currency: 'EUR',
  is_primary: false,
}

describe('runUnattendedReconciliationSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs once per enabled cash account with that account\'s scope', async () => {
    const supabase = makeSupabase({ data: [CA_1930, CA_1931, CA_1932_EUR], error: null })
    runReconciliationMock.mockResolvedValue(emptyRunResult())

    const result = await runUnattendedReconciliationSweep(
      supabase as never,
      'company-1',
      'user-1',
      { dateFrom: '2026-01-01', dateTo: '2026-06-30' },
    )

    expect(runReconciliationMock).toHaveBeenCalledTimes(3)

    // Primary 1930: claims unassigned NULL-cash_account_id rows.
    expect(runReconciliationMock).toHaveBeenNthCalledWith(1, supabase, 'company-1', 'user-1', {
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
      accountNumber: '1930',
      currency: 'SEK',
      cashAccountId: CA_1930.id,
      includeUnassigned: true,
      confidenceThreshold: DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
      persistSuggestions: true,
    })
    // Non-primary same-currency 1931: strict scope, never claims NULL rows.
    expect(runReconciliationMock).toHaveBeenNthCalledWith(2, supabase, 'company-1', 'user-1', {
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
      accountNumber: '1931',
      currency: 'SEK',
      cashAccountId: CA_1931.id,
      includeUnassigned: false,
      confidenceThreshold: DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
      persistSuggestions: true,
    })
    // Foreign account reconciles in its own currency.
    expect(runReconciliationMock).toHaveBeenNthCalledWith(3, supabase, 'company-1', 'user-1', {
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
      accountNumber: '1932',
      currency: 'EUR',
      cashAccountId: CA_1932_EUR.id,
      includeUnassigned: false,
      confidenceThreshold: DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
      persistSuggestions: true,
    })

    expect(result.accounts).toHaveLength(3)
  })

  it('falls back to a single legacy 1930/SEK run when the company has no cash_accounts rows', async () => {
    const supabase = makeSupabase({ data: [], error: null })
    runReconciliationMock.mockResolvedValue(emptyRunResult({ applied: 2 }))

    const result = await runUnattendedReconciliationSweep(supabase as never, 'company-1', 'user-1')

    expect(runReconciliationMock).toHaveBeenCalledTimes(1)
    expect(runReconciliationMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      dateFrom: undefined,
      dateTo: undefined,
      accountNumber: '1930',
      currency: 'SEK',
      cashAccountId: undefined,
      includeUnassigned: true,
      confidenceThreshold: DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
      persistSuggestions: true,
    })
    expect(result.applied).toBe(2)
    expect(result.accounts[0].cashAccountId).toBeNull()
  })

  it('aggregates per-account results into sweep totals', async () => {
    const supabase = makeSupabase({ data: [CA_1930, CA_1931], error: null })
    runReconciliationMock
      .mockResolvedValueOnce(
        emptyRunResult({ applied: 3, skippedBelowThreshold: 2, matches: [1, 2, 3, 4, 5] }),
      )
      .mockResolvedValueOnce(emptyRunResult({ applied: 1, errors: 1, matches: [1, 2] }))

    const result = await runUnattendedReconciliationSweep(supabase as never, 'company-1', 'user-1')

    expect(result.applied).toBe(4)
    expect(result.errors).toBe(1)
    expect(result.skippedBelowThreshold).toBe(2)
    expect(result.accounts[0]).toMatchObject({ accountNumber: '1930', applied: 3, proposed: 5 })
    expect(result.accounts[1]).toMatchObject({ accountNumber: '1931', applied: 1, proposed: 2 })
  })

  it('aggregates suggested and derives unmatched from the candidate pool', async () => {
    const supabase = makeSupabase({ data: [CA_1930, CA_1931], error: null })
    runReconciliationMock
      .mockResolvedValueOnce(
        emptyRunResult({ applied: 5, suggested: 2, candidates: 10, matches: [1, 2, 3, 4, 5, 6, 7] }),
      )
      .mockResolvedValueOnce(emptyRunResult({ applied: 1, suggested: 0, candidates: 3, matches: [1] }))

    const result = await runUnattendedReconciliationSweep(supabase as never, 'company-1', 'user-1')

    expect(result.applied).toBe(6)
    expect(result.suggested).toBe(2)
    // 13 candidates, 6 auto-linked, 2 suggested: 5 rows left for the backstop.
    expect(result.unmatched).toBe(5)
  })

  it('one account failing does not abort the others; the failure counts as one error', async () => {
    const supabase = makeSupabase({ data: [CA_1930, CA_1931], error: null })
    runReconciliationMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(emptyRunResult({ applied: 2, matches: [1, 2] }))

    const result = await runUnattendedReconciliationSweep(supabase as never, 'company-1', 'user-1')

    expect(runReconciliationMock).toHaveBeenCalledTimes(2)
    expect(result.errors).toBe(1)
    expect(result.applied).toBe(2)
    expect(result.accounts[0]).toMatchObject({ accountNumber: '1930', applied: 0, errors: 1 })
    expect(result.accounts[1]).toMatchObject({ accountNumber: '1931', applied: 2, errors: 0 })
  })

  it('throws when the cash_accounts lookup fails (never degrades to the pooled run)', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'rls denied' } })

    await expect(
      runUnattendedReconciliationSweep(supabase as never, 'company-1', 'user-1'),
    ).rejects.toThrow('Kunde inte hämta kassakonton')
    expect(runReconciliationMock).not.toHaveBeenCalled()
  })

  it('carries errors into the stamped summary so a crashed account never reads as "all done"', async () => {
    const supabase = makeSupabase({ data: [CA_1930, CA_1931], error: null })
    runReconciliationMock
      .mockResolvedValueOnce(emptyRunResult({ applied: 5, candidates: 5, matches: [1, 2, 3, 4, 5] }))
      // 1931 throws: its candidates never enter the pool, so unmatched: 0
      // would be a lie without the errors field.
      .mockRejectedValueOnce(new Error('transient'))

    const result = await runUnattendedReconciliationSweep(supabase as never, 'company-1', 'user-1', {
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
    })
    const summary = toSweepSummary(result, { dateFrom: '2026-01-01', dateTo: '2026-06-30' })

    expect(summary.auto_linked).toBe(5)
    expect(summary.unmatched).toBe(0)
    expect(summary.errors).toBe(1)
    expect(summary.date_from).toBe('2026-01-01')
  })

  it('honors an explicit confidenceThreshold override', async () => {
    const supabase = makeSupabase({ data: [CA_1930], error: null })
    runReconciliationMock.mockResolvedValue(emptyRunResult())

    await runUnattendedReconciliationSweep(supabase as never, 'company-1', 'user-1', {
      confidenceThreshold: 0.95,
    })

    expect(runReconciliationMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ confidenceThreshold: 0.95 }),
    )
  })
})
