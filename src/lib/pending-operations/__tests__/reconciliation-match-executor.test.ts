/**
 * commitReconciliationMatch, driven through the public commitPendingOperation
 * dispatcher. The linking lives in lib/reconciliation/actions.ts matchPairs
 * (unit tested there); these tests cover the wiring for the bank 1:N pair of
 * issue #1553: the staged pair (one row, several verifikat, allocations)
 * reaches matchPairs intact and as ONE pair, never re-split into independent
 * 1:1 links, and partial success surfaces in the committed payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const matchMock = vi.fn()
vi.mock('@/lib/reconciliation/actions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/actions')>('@/lib/reconciliation/actions')
  return { ...actual, matchPairs: (...args: unknown[]) => matchMock(...args) }
})

import { commitPendingOperation } from '../commit'

const CASH = '11111111-1111-4111-8111-111111111111'
const KEY = `bank:${CASH}`
const T1 = '22222222-2222-4222-8222-222222222222'
const E1 = '44444444-4444-4444-8444-444444444444'
const E2 = '55555555-5555-4555-8555-555555555555'

const splitPair = {
  external_ids: [T1],
  journal_entry_ids: [E1, E2],
  allocations: [
    { journal_entry_id: E1, amount: -500 },
    { journal_entry_id: E2, amount: -300 },
  ],
}

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'reconciliation_match',
    status: 'pending',
    title: 'test',
    params: { account_key: KEY, pairs: [splitPair] },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-08-29T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-08-29T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: reconciliation_match with a bank 1:N pair (#1553)', () => {
  it('passes the staged split pair, allocations included, to matchPairs as one pair', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's committed update
    matchMock.mockResolvedValue({
      dry_run: false,
      considered: 1,
      applied: [
        { external_id: T1, journal_entry_id: E1, allocated_amount: -500 },
        { external_id: T1, journal_entry_id: E2, allocated_amount: -300 },
      ],
      skipped: [],
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(matchMock).toHaveBeenCalledTimes(1)
    expect(matchMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', KEY, { pairs: [splitPair] }, { dryRun: false })
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ account_key: KEY, applied_count: 2, skipped_count: 0 })
    expect((result.data as { applied: Array<{ allocated_amount: number }> }).applied.map((a) => a.allocated_amount)).toEqual([-500, -300])
  })

  it('reports a refused split (sum mismatch at commit time) as a 409 auto-reject carrying the skip code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's failed update
    matchMock.mockResolvedValue({
      dry_run: false,
      considered: 1,
      applied: [],
      skipped: [
        { pair: splitPair, code: 'PAIR_NOT_CLOSED', message: 'Fördelningen (-800) stämmer inte med transaktionens belopp (-900).' },
      ],
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    // 409 is a conflict with the ledger's current state, which the
    // dispatcher records as rejected (like a 404), not as a failed attempt.
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('PAIR_NOT_CLOSED')
    expect(result.error).toMatch(/PAIR_NOT_CLOSED/)
  })
})
