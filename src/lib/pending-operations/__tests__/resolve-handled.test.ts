import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const mockAppendProcessingHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

import { resolveHandledProposals } from '../resolve-handled'
import { isHandledElsewhere, HANDLED_ELSEWHERE_REASON } from '../handled-elsewhere'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

function op(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    company_id: 'company-1',
    user_id: 'user-1',
    operation_type: 'categorize_transaction',
    status: 'pending',
    risk_level: 'medium',
    title: 'test',
    params: { transaction_id: 'tx-1', category: 'expense_office' },
    preview_data: {},
    result_data: null,
    ...overrides,
  } as PendingOperation
}

describe('resolveHandledProposals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('reads nothing when no proposal books or ignores a bank row', async () => {
    const closed = await resolveHandledProposals(supabase as never, 'company-1', [
      op({ operation_type: 'create_voucher', params: {} }),
      op({ id: 'op-2', operation_type: 'create_customer', params: { name: 'Acme' } }),
    ])

    expect(closed).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('closes a categorize proposal whose bank row is already booked, as superseded by the system', async () => {
    enqueue({ data: [{ id: 'tx-1', is_booked: true }, { id: 'tx-2', is_booked: false }] })
    enqueue({ data: [{ id: 'op-1' }] })

    const closed = await resolveHandledProposals(supabase as never, 'company-1', [
      op({}),
      op({ id: 'op-2', params: { transaction_id: 'tx-2', category: 'expense_office' } }),
    ])

    expect(closed).toEqual(['op-1'])
    const [update] = findCalls('pending_operations', 'update')
    expect(update[0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'superseded',
      result_data: { auto_rejected: true, reason: HANDLED_ELSEWHERE_REASON },
    })
    // Only the proposal with the booked row, only while it is still pending.
    expect(findCalls('pending_operations', 'in')).toEqual([['id', ['op-1']]])
    expect(findCalls('pending_operations', 'eq')).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['status', 'pending']]),
    )
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory.mock.calls[0][0]).toMatchObject({
      eventType: 'PendingOperationRejected',
      aggregateId: 'op-1',
      actor: { type: 'system' },
      payload: { operation_id: 'op-1', channel: 'system', reason: HANDLED_ELSEWHERE_REASON },
    })
  })

  it('closes a bulk proposal when any of its rows is booked, and an ignore of a booked row', async () => {
    enqueue({ data: [{ id: 'tx-1', is_booked: false }, { id: 'tx-2', is_booked: true }, { id: 'tx-3', is_booked: true }] })
    enqueue({ data: [{ id: 'bulk-1' }, { id: 'ignore-1' }] })

    const closed = await resolveHandledProposals(supabase as never, 'company-1', [
      op({ id: 'bulk-1', operation_type: 'bulk_book_transactions', params: { tx_ids: ['tx-1', 'tx-2'] } }),
      op({ id: 'ignore-1', operation_type: 'ignore_transaction', params: { transaction_id: 'tx-3' } }),
    ])

    expect(closed).toEqual(['bulk-1', 'ignore-1'])
  })

  it('leaves every proposal alone when no row is booked: unbooked, missing and ignored rows decide nothing', async () => {
    enqueue({ data: [{ id: 'tx-1', is_booked: false }] })

    const closed = await resolveHandledProposals(supabase as never, 'company-1', [
      op({}),
      op({ id: 'op-2', params: { transaction_id: 'tx-gone', category: 'expense_office' } }),
    ])

    expect(closed).toEqual([])
    expect(findCalls('pending_operations', 'update')).toEqual([])
  })

  it('skips operations that are not pending', async () => {
    const closed = await resolveHandledProposals(supabase as never, 'company-1', [op({ status: 'committed' })])

    expect(closed).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('reports only what the compare-and-set closed: one approved meanwhile stays', async () => {
    enqueue({ data: [{ id: 'tx-1', is_booked: true }] })
    enqueue({ data: [] })

    const closed = await resolveHandledProposals(supabase as never, 'company-1', [op({})])

    expect(closed).toEqual([])
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('never throws: a failed read closes nothing', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const closed = await resolveHandledProposals(supabase as never, 'company-1', [op({})])

    expect(closed).toEqual([])
    expect(findCalls('pending_operations', 'update')).toEqual([])
  })
})

describe('isHandledElsewhere', () => {
  it('is true only for a rejection this sweep made', () => {
    expect(isHandledElsewhere({ status: 'rejected', result_data: { auto_rejected: true, reason: HANDLED_ELSEWHERE_REASON } })).toBe(true)
    expect(isHandledElsewhere({ status: 'rejected', result_data: { auto_rejected: true, reason: 'expired' } })).toBe(false)
    expect(isHandledElsewhere({ status: 'rejected', result_data: { rejected_by: 'user-1' } })).toBe(false)
    expect(isHandledElsewhere({ status: 'pending', result_data: null })).toBe(false)
  })
})
