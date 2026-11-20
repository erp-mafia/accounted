/**
 * The task_state mapping (./task-state.ts): every pending_operations status,
 * and the rejected rows the commit wrote told apart from a person's no, an
 * expiry and a supersede, with and without the system categories.
 */
import { describe, expect, it } from 'vitest'
import { PENDING_OPERATION_STATUSES } from '../view'
import { pendingOperationTaskState, PENDING_OPERATION_TASK_STATES, TERMINAL_TASK_STATES } from '../task-state'

describe('pendingOperationTaskState', () => {
  it.each([
    ['pending', 'working'],
    ['committing', 'working'],
    ['committed', 'completed'],
    ['failed_partial', 'failed'],
    ['unknown', 'failed'],
  ] as const)('maps %s to %s', (status, taskState) => {
    expect(pendingOperationTaskState({ status })).toBe(taskState)
  })

  it('maps every status the table allows to a task state', () => {
    for (const status of PENDING_OPERATION_STATUSES) {
      expect(PENDING_OPERATION_TASK_STATES).toContain(pendingOperationTaskState({ status }))
    }
  })

  it('maps a rejection the commit wrote to failed', () => {
    expect(pendingOperationTaskState({ status: 'rejected', rejection_category: 'failed' })).toBe('failed')
  })

  it.each(['wrong_category', 'wrong_amount', 'duplicate', 'wrong_period', 'other', 'expired', 'superseded'])(
    'maps a rejection with category %s to cancelled',
    (category) => {
      // A supersede writes an auto-reject shape; its category still decides.
      expect(
        pendingOperationTaskState({
          status: 'rejected',
          rejection_category: category,
          result_data: { auto_rejected: true, reason: 'Posten är redan kopplad.' },
        }),
      ).toBe('cancelled')
    },
  )

  it('maps a person\'s rejection without a category (the MCP reject tool) to cancelled', () => {
    expect(
      pendingOperationTaskState({
        status: 'rejected',
        rejection_category: null,
        result_data: { rejected_by: 'user-1', rejected_via: 'api_key' },
      }),
    ).toBe('cancelled')
  })

  it('reads rows from before the system categories by the commit\'s result_data shape', () => {
    const legacy = (result_data: Record<string, unknown>) =>
      pendingOperationTaskState({ status: 'rejected', rejection_category: null, result_data })
    expect(legacy({ error: 'Executor failed', threw: true })).toBe('failed')
    expect(legacy({ error: 'Konto saknas', http_status: 400 })).toBe('failed')
    expect(legacy({ auto_rejected: true, reason: 'Fakturan hittades inte.' })).toBe('failed')
    // The expiry cron's auto-reject is nobody's approval.
    expect(legacy({ auto_rejected: true, reason: 'expired' })).toBe('cancelled')
  })

  it('treats completed, failed and cancelled as terminal and working as not', () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual(['cancelled', 'completed', 'failed'])
    expect(TERMINAL_TASK_STATES.has('working')).toBe(false)
  })
})
