/**
 * gnubok_approve_pending_operation with operation_ids: several of one
 * company's operations in one call.
 *
 * Agents approving their proposals one call each stopped part way and left
 * the rest pending. One call settles them, but each operation keeps the gates
 * a single approval has: high-risk ones need their own acknowledgment and
 * web-only ones a person in the app, so both are only listed; an id that is
 * not this company's is reported as not found; nothing is ever approved with
 * confirmed=true on the caller's behalf.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const commitSpy = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitSpy(...args),
}))

import { tools } from '../server'

const approve = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!

const ID = {
  low: '11111111-1111-4111-8111-111111111111',
  medium: '22222222-2222-4222-8222-222222222222',
  high: '33333333-3333-4333-8333-333333333333',
  webOnly: '44444444-4444-4444-8444-444444444444',
  settled: '55555555-5555-4555-8555-555555555555',
  elsewhere: '66666666-6666-4666-8666-666666666666',
}

function operation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    operation_type: 'categorize_transaction',
    company_id: 'company-1',
    status: 'pending',
    risk_level: 'medium',
    params: {},
    result_data: null,
    ...overrides,
  }
}

const run = (supabase: unknown, args: Record<string, unknown>) =>
  approve.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' }) as Promise<Record<string, unknown>>

beforeEach(() => {
  vi.clearAllMocks()
  commitSpy.mockResolvedValue({ status: 'committed', data: {}, operation_status: 'committed' })
})

describe('gnubok_approve_pending_operation: operation_ids', () => {
  it('commits the low and medium ones and only lists what needs its own approval', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        operation(ID.low, { risk_level: 'low' }),
        operation(ID.medium),
        operation(ID.high, { operation_type: 'create_voucher', risk_level: 'high' }),
        operation(ID.webOnly, { operation_type: 'create_grant' }),
        operation(ID.settled, { status: 'committed' }),
      ],
      error: null,
    })

    const result = await run(supabase, {
      operation_ids: [ID.low, ID.medium, ID.high, ID.webOnly, ID.settled, ID.elsewhere],
    })

    // Read within this company only: an id staged elsewhere is not found here.
    expect(findCall('pending_operations', 'eq')).toEqual(['company_id', 'company-1'])
    expect(commitSpy).toHaveBeenCalledTimes(2)
    for (const [call] of commitSpy.mock.calls) {
      expect((call as { confirmed?: boolean }).confirmed).not.toBe(true)
    }
    expect(result).toMatchObject({ status: 'batch', committed: 2, skipped: 3, failed: 1 })
    expect(result.results).toEqual([
      expect.objectContaining({ operation_id: ID.low, status: 'committed' }),
      expect.objectContaining({ operation_id: ID.medium, status: 'committed' }),
      expect.objectContaining({ operation_id: ID.high, status: 'skipped', reason: 'high_risk_requires_individual_approval' }),
      expect.objectContaining({ operation_id: ID.webOnly, status: 'skipped', reason: 'person_approves_in_app' }),
      expect.objectContaining({ operation_id: ID.settled, status: 'skipped', reason: 'not_pending', operation_status: 'committed' }),
      expect.objectContaining({ operation_id: ID.elsewhere, status: 'failed', error_code: 'NOT_FOUND' }),
    ])
  })

  it('reports a commit that fails and goes on with the rest', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [operation(ID.low), operation(ID.medium)], error: null })
    commitSpy
      .mockResolvedValueOnce({ status: 'failed', error: 'Möjlig dubblettbokföring', code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE', operation_status: 'rejected' })
      .mockResolvedValueOnce({ status: 'committed', data: {}, operation_status: 'committed' })

    const result = await run(supabase, { operation_ids: [ID.low, ID.medium] })

    expect(result).toMatchObject({ status: 'batch', committed: 1, skipped: 0, failed: 1 })
    expect(result.results).toEqual([
      expect.objectContaining({ operation_id: ID.low, status: 'failed', error_code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' }),
      expect.objectContaining({ operation_id: ID.medium, status: 'committed' }),
    ])
  })

  it('commits oldest staged first, whatever order the ids are listed in (crm#1815)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        operation(ID.medium, { created_at: '2026-03-02T10:00:02.000000+00:00' }),
        operation(ID.low, { created_at: '2026-03-02T10:00:01.000000+00:00' }),
      ],
      error: null,
    })

    const result = await run(supabase, { operation_ids: [ID.medium, ID.low] })

    expect(commitSpy.mock.calls.map((call) => (call[3] as { id: string }).id)).toEqual([ID.low, ID.medium])
    expect(result.results).toEqual([
      expect.objectContaining({ operation_id: ID.low, status: 'committed' }),
      expect.objectContaining({ operation_id: ID.medium, status: 'committed' }),
    ])
  })

  it('settles a repeated id once', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [operation(ID.low)], error: null })

    const result = await run(supabase, { operation_ids: [ID.low, ID.low] })

    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect(result.results).toHaveLength(1)
  })

  it.each([
    ['an empty list', []],
    ['an id that is not a UUID', ['op-1']],
    ['more than 50 ids', Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)],
  ])('refuses %s before reading anything', async (_label, ids) => {
    const { supabase, findCall } = createQueuedMockSupabase()

    await expect(run(supabase, { operation_ids: ids })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(findCall('pending_operations', 'select')).toBeUndefined()
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('takes one of operation_id, operation_ids and batch_id', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(run(supabase, { operation_id: ID.low, operation_ids: [ID.medium] })).rejects.toThrow(
      'Pass only one of operation_id, operation_ids and batch_id',
    )
    await expect(run(supabase, { batch_id: ID.high, operation_ids: [ID.medium] })).rejects.toThrow(
      'Pass only one of operation_id, operation_ids and batch_id',
    )
    expect(commitSpy).not.toHaveBeenCalled()
  })
})
