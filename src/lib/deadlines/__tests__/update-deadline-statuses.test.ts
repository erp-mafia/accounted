import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: (): unknown => logger }
  return { createLogger: () => logger }
})

import { updateDeadlineStatuses } from '../status-engine'

beforeEach(() => {
  vi.clearAllMocks()
})

/*
 * 23:30 UTC is already the next day in Stockholm, in summer (UTC+2) and in
 * winter (UTC+1). The overdue cutoff and the action_needed threshold are both
 * Swedish calendar days (accounted#18).
 */
describe('updateDeadlineStatuses: bounds are Swedish calendar days', () => {
  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2026-07-02', '2026-07-16'],
    ['winter', '2026-01-15T23:30:00Z', '2026-01-16', '2026-01-30'],
  ])('%s: %s counts from %s', async (_season, instant, today, threshold) => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'd1' }] })
    enqueue({ data: [{ id: 'd2' }, { id: 'd3' }] })

    const result = await updateDeadlineStatuses(supabase as never, new Date(instant))

    expect(result).toEqual({ updated: 3, newlyOverdue: 1, newlyActionNeeded: 2 })
    expect(findCalls('deadlines', 'lt')).toEqual([['due_date', today]])
    expect(findCalls('deadlines', 'gte')).toEqual([['due_date', today]])
    expect(findCalls('deadlines', 'lte')).toEqual([['due_date', threshold]])
  })
})

describe('updateDeadlineStatuses: a failed update fails the run', () => {
  it('throws when the overdue update fails, after still trying the action_needed one', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: { message: 'canceling statement due to statement timeout' } })
    enqueue({ data: [{ id: 'd2' }] })

    await expect(updateDeadlineStatuses(supabase as never, new Date('2026-07-01T10:00:00Z'))).rejects.toThrow(
      'Deadline status update failed (overdue: canceling statement due to statement timeout); 1 deadlines were updated',
    )
    expect(findCalls('deadlines', 'update')).toHaveLength(2)
  })

  it('throws when the action_needed update fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ error: { message: 'connection reset' } })

    await expect(updateDeadlineStatuses(supabase as never, new Date('2026-07-01T10:00:00Z'))).rejects.toThrow(
      'action_needed: connection reset',
    )
  })
})
