import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockAppend = vi.hoisted(() => vi.fn())
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...a: unknown[]) => mockAppend(...a),
}))

import { rejectPendingOperations } from '../reject'

const APP_ACTOR = { userId: 'user-1', type: 'user' }

beforeEach(() => {
  vi.clearAllMocks()
  mockAppend.mockResolvedValue('event-1')
})

describe('rejectPendingOperations', () => {
  it('records who rejected, through which door, and appends one audit row per rejected operation', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          { id: 'op-1', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low' },
          { id: 'op-2', status: 'pending', operation_type: 'create_voucher', risk_level: 'medium' },
        ],
      },
      { data: [{ id: 'op-1' }, { id: 'op-2' }], error: null },
    ])

    const result = await rejectPendingOperations(supabase as never, {
      companyId: 'company-1',
      ids: ['op-1', 'op-2'],
      category: 'wrong_amount',
      reason: 'fel belopp',
      actor: APP_ACTOR,
      channel: 'app',
    })

    expect(result).toEqual({
      ok: true,
      outcomes: [
        { id: 'op-1', outcome: 'rejected' },
        { id: 'op-2', outcome: 'rejected' },
      ],
    })
    expect(findCalls('pending_operations', 'update')[0]?.[0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'wrong_amount',
      rejection_reason: 'fel belopp',
      result_data: { rejected_by: 'user-1', rejected_via: 'user', reason: 'fel belopp' },
    })
    // Compare-and-set: only rows still pending, in the caller's company.
    expect(findCalls('pending_operations', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['status', 'pending'],
      ]),
    )
    expect(mockAppend).toHaveBeenCalledTimes(2)
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        aggregateId: 'op-2',
        eventType: 'PendingOperationRejected',
        payload: expect.objectContaining({
          operation_id: 'op-2',
          operation_type: 'create_voucher',
          risk_level: 'medium',
          channel: 'app',
          has_reason: true,
        }),
        actor: { type: 'user', id: 'user-1' },
      }),
    )
  })

  it('stores no category when none was given (an agent relaying a bare no)', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'op-1', status: 'pending', operation_type: 'x', risk_level: 'low' }] },
      { data: [{ id: 'op-1' }], error: null },
    ])

    await rejectPendingOperations(supabase as never, {
      companyId: 'company-1',
      ids: ['op-1'],
      actor: { userId: 'user-1', type: 'api_key', id: 'key-1', label: 'Claude' },
      channel: 'mcp',
    })

    const update = findCalls('pending_operations', 'update')[0]?.[0] as Record<string, unknown>
    expect(update).not.toHaveProperty('rejection_category')
    expect(update).not.toHaveProperty('rejection_reason')
    expect(update.result_data).toEqual({ rejected_by: 'user-1', rejected_via: 'api_key', actor_id: 'key-1' })
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ channel: 'mcp', has_reason: false }),
        actor: { type: 'api_key', id: 'key-1', label: 'Claude' },
      }),
    )
  })

  it("records a service account's key as service_account in the history row, named after the account", async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'op-1', status: 'pending', operation_type: 'x', risk_level: 'low' }] },
      { data: [{ id: 'op-1' }], error: null },
    ])

    await rejectPendingOperations(supabase as never, {
      companyId: 'company-1',
      ids: ['op-1'],
      actor: { userId: 'sponsor-1', type: 'service_account', id: 'key-sa', label: 'Nattlig synk' },
      channel: 'api',
    })

    const update = findCalls('pending_operations', 'update')[0]?.[0] as Record<string, unknown>
    expect(update.result_data).toEqual({ rejected_by: 'sponsor-1', rejected_via: 'service_account', actor_id: 'key-sa' })
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'service_account', id: 'key-sa', label: 'Nattlig synk' } }),
    )
  })

  it('reports missing, already-resolved and lost-race rows without writing over them', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          { id: 'op-done', status: 'committed', operation_type: 'x', risk_level: 'low' },
          { id: 'op-race', status: 'pending', operation_type: 'x', risk_level: 'low' },
        ],
      },
      // The guarded write matched nothing: a parallel approval claimed op-race.
      { data: [], error: null },
    ])

    const result = await rejectPendingOperations(supabase as never, {
      companyId: 'company-1',
      ids: ['op-missing', 'op-done', 'op-race'],
      category: 'other',
      actor: APP_ACTOR,
      channel: 'app',
    })

    expect(result).toEqual({
      ok: true,
      outcomes: [
        { id: 'op-missing', outcome: 'not_found' },
        { id: 'op-done', outcome: 'not_pending', status: 'committed' },
        { id: 'op-race', outcome: 'lost_race' },
      ],
    })
    expect(findCalls('pending_operations', 'in')[1]).toEqual(['id', ['op-race']])
    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('runs no write when nothing is pending', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'rejected', operation_type: 'x', risk_level: 'low' }] })

    const result = await rejectPendingOperations(supabase as never, {
      companyId: 'company-1',
      ids: ['op-1'],
      category: 'other',
      actor: APP_ACTOR,
      channel: 'app',
    })

    expect(result).toEqual({ ok: true, outcomes: [{ id: 'op-1', outcome: 'not_pending', status: 'rejected' }] })
    expect(findCalls('pending_operations', 'update')).toEqual([])
  })

  it('keeps the rejection when the audit append fails', async () => {
    mockAppend.mockRejectedValue(new Error('history down'))
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'op-1', status: 'pending', operation_type: 'x', risk_level: 'low' }] },
      { data: [{ id: 'op-1' }], error: null },
    ])

    const result = await rejectPendingOperations(supabase as never, {
      companyId: 'company-1',
      ids: ['op-1'],
      category: 'other',
      actor: APP_ACTOR,
      channel: 'app',
    })

    expect(result).toEqual({ ok: true, outcomes: [{ id: 'op-1', outcome: 'rejected' }] })
  })

  it('answers the failing stage when a read or the write errors', async () => {
    const fetchFail = createQueuedMockSupabase()
    fetchFail.enqueue({ data: null, error: { message: 'connection reset' } })
    expect(
      await rejectPendingOperations(fetchFail.supabase as never, {
        companyId: 'company-1',
        ids: ['op-1'],
        actor: APP_ACTOR,
        channel: 'app',
      }),
    ).toEqual({ ok: false, stage: 'fetch', error: { message: 'connection reset' } })

    const updateFail = createQueuedMockSupabase()
    updateFail.enqueueMany([
      { data: [{ id: 'op-1', status: 'pending', operation_type: 'x', risk_level: 'low' }] },
      { data: null, error: { message: 'deadlock' } },
    ])
    expect(
      await rejectPendingOperations(updateFail.supabase as never, {
        companyId: 'company-1',
        ids: ['op-1'],
        actor: APP_ACTOR,
        channel: 'app',
      }),
    ).toEqual({ ok: false, stage: 'update', error: { message: 'deadlock' } })
  })
})
