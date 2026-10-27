import { beforeEach, describe, expect, it, vi } from 'vitest'

const errorLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => errorLog }))

vi.mock('@/lib/reconciliation/unattended-sweep', () => ({
  runUnattendedReconciliationSweep: vi.fn(),
  toSweepSummary: vi.fn(() => ({ summary: true })),
}))

import { createTableMockSupabase } from '@/tests/helpers'
import { runUnattendedReconciliationSweep } from '@/lib/reconciliation/unattended-sweep'
import { sweepAfterOverlappingSync } from '../post-sync-sweep'

const mockSweep = vi.mocked(runUnattendedReconciliationSweep)
const log = { info: vi.fn(), warn: vi.fn() }

function sweepResult(applied: number) {
  return { accounts: [], applied, errors: 0, skippedBelowThreshold: 0, suggested: 0, unmatched: 0 }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1',
    ledgerAccounts: ['1930', '1930', null, '1931'], fromDate: '2025-10-01', toDate: '2026-10-17', returnedMin: null, log,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sweepAfterOverlappingSync', () => {
  it('sweeps the fetched ledger accounts once each and stamps the summary on the connection', async () => {
    const { supabase, calls } = createTableMockSupabase({ bank_connections: [{ data: null, error: null }] })
    mockSweep.mockResolvedValue(sweepResult(155))
    const applied = await sweepAfterOverlappingSync(supabase as never, input())
    expect(applied).toBe(155)
    expect(mockSweep).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', { dateFrom: '2025-10-01', dateTo: '2026-10-17', ledgerAccounts: ['1930', '1931'] })
    expect(calls.some((c) => c.table === 'bank_connections')).toBe(true)
  })

  it('starts from the oldest date the bank returned when it over-returned history', async () => {
    const { supabase } = createTableMockSupabase({ bank_connections: [{ data: null, error: null }] })
    mockSweep.mockResolvedValue(sweepResult(0))
    await sweepAfterOverlappingSync(supabase as never, input({ returnedMin: '2024-09-23' }))
    expect(mockSweep).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', expect.objectContaining({ dateFrom: '2024-09-23' }))
  })

  it('leaves the rows for review and counts 0 when the sweep fails', async () => {
    const { supabase } = createTableMockSupabase({ bank_connections: [{ data: null, error: null }] })
    mockSweep.mockRejectedValue(new Error('boom'))
    const applied = await sweepAfterOverlappingSync(supabase as never, input())
    expect(applied).toBe(0)
    // Never swept again, and the rows sit unhandled next to their verifikat: an error, not a warning.
    expect(errorLog.error).toHaveBeenCalledWith('Post-sync reconciliation sweep failed', expect.objectContaining({ connectionId: 'conn-1', companyId: 'co-1', message: 'boom' }))
  })

  it('reports a summary that could not be stamped on the connection', async () => {
    const { supabase } = createTableMockSupabase({ bank_connections: [{ data: null, error: { code: '42501', message: 'denied' } }] })
    mockSweep.mockResolvedValue(sweepResult(3))
    expect(await sweepAfterOverlappingSync(supabase as never, input())).toBe(3)
    expect(errorLog.error).toHaveBeenCalledWith('Post-sync reconciliation summary not stamped', expect.objectContaining({ connectionId: 'conn-1', code: '42501' }))
  })
})
