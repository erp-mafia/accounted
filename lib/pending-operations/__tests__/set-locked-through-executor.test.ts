/**
 * Executor tests for the staged month lock (set_bookkeeping_locked_through),
 * reached through commitPendingOperation like account-and-note-executors.
 * Queue order after the CAS claim: settings read → unbooked head-count →
 * settings update → finalize.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { commitPendingOperation } from '../commit'
import { getRiskLevel } from '../risk-tiers'

function makeOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'set_bookkeeping_locked_through',
    status: 'pending',
    title: 'Lås bokföringen t.o.m. 2026-06-30',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-07-19T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-19T00:00:00Z',
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('risk tier', () => {
  it('set_bookkeeping_locked_through is high (never bulk-approved)', () => {
    expect(getRiskLevel('set_bookkeeping_locked_through')).toBe('high')
  })
})

describe('commitPendingOperation: set_bookkeeping_locked_through', () => {
  it('advances the lock when the range has no unbooked transactions', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { bookkeeping_locked_through: '2026-05-31' } }) // settings read
    enqueue({ data: null, count: 0 }) // unbooked head-count
    enqueue({ data: { bookkeeping_locked_through: '2026-06-30' } }) // update read-back
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeOp({ locked_through: '2026-06-30' }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ locked_through: '2026-06-30', previous: '2026-05-31' })
  })

  it('refuses to retreat the lock date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { bookkeeping_locked_through: '2026-06-30' } }) // settings read
    enqueue({ data: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeOp({ locked_through: '2026-05-31' }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/redan låst/)
  })

  it('re-runs the unbooked hard gate at commit time', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { bookkeeping_locked_through: null } }) // settings read
    enqueue({ data: null, count: 4 }) // unbooked head-count
    enqueue({ data: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeOp({ locked_through: '2026-06-30' }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/obokförda/)
  })

  it('rejects malformed dates', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeOp({ locked_through: 'juni' }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })
})
