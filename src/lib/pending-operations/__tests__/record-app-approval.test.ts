import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PendingOperation } from '@/types'

const mockAppend = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppend(...args),
}))

import { recordAppApproval } from '../record-app-approval'

const OPERATION: Pick<PendingOperation, 'id' | 'operation_type' | 'risk_level'> = {
  id: 'op-1',
  operation_type: 'categorize_transaction',
  risk_level: 'low',
}

describe('recordAppApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAppend.mockResolvedValue('event-1')
  })

  it('appends one PendingOperationApproved row with channel app and the person as actor', async () => {
    await recordAppApproval({
      companyId: 'company-1',
      userId: 'user-1',
      operation: OPERATION,
      commitMethod: 'bulk_accept',
      outcome: 'committed',
    })

    expect(mockAppend).toHaveBeenCalledTimes(1)
    expect(mockAppend).toHaveBeenCalledWith({
      companyId: 'company-1',
      correlationId: 'op-1',
      aggregateType: 'System',
      aggregateId: 'op-1',
      eventType: 'PendingOperationApproved',
      payload: {
        operation_id: 'op-1',
        operation_type: 'categorize_transaction',
        risk_level: 'low',
        outcome: 'committed',
        commit_method: 'bulk_accept',
        channel: 'app',
      },
      actor: { type: 'user', id: 'user-1' },
      occurredAt: expect.any(Date),
    })
  })

  it('records a failed attempt with its outcome', async () => {
    await recordAppApproval({
      companyId: 'company-1',
      userId: 'user-1',
      operation: OPERATION,
      commitMethod: 'user_accept',
      outcome: 'failed',
    })

    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: 'failed', commit_method: 'user_accept', channel: 'app' }),
      }),
    )
  })

  it('never throws when the append fails: the commit already happened', async () => {
    mockAppend.mockRejectedValue(new Error('insert failed'))

    await expect(
      recordAppApproval({
        companyId: 'company-1',
        userId: 'user-1',
        operation: OPERATION,
        commitMethod: 'user_accept',
        outcome: 'committed',
      }),
    ).resolves.toBeUndefined()
  })
})
