import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { filterOpenDeadlines, isOpenDeadline } from '../open'
import { isDeadlineOverdue } from '@/lib/calendar/utils'
import { getDeadlinesNeedingAttention } from '../status-engine'
import type { Deadline } from '@/types'

/*
 * crm#1848, #207: one rule for "an open deadline". A completed deadline and a
 * dismissed one are both closed, whatever the stored status column says.
 */
describe('an open deadline', () => {
  it('narrows a query to rows that are neither completed nor dismissed', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await filterOpenDeadlines(supabase.from('deadlines').select('id').eq('company_id', 'company-1'))

    expect(findCalls('deadlines', 'eq')).toContainEqual(['is_completed', false])
    expect(findCalls('deadlines', 'is')).toEqual([['dismissed_at', null]])
  })

  it.each([
    ['open', { is_completed: false, dismissed_at: null }, true],
    ['open, dismissal not selected', { is_completed: false }, true],
    ['completed', { is_completed: true, dismissed_at: null }, false],
    ['dismissed', { is_completed: false, dismissed_at: '2026-11-01T10:00:00Z' }, false],
  ])('%s row: open is %s', (_name, row, open) => {
    expect(isOpenDeadline(row)).toBe(open)
  })

  it('never calls a completed or dismissed deadline overdue, even with status overdue', () => {
    const pastDue = { due_date: '2020-01-01', status: 'overdue' } as Deadline
    expect(isDeadlineOverdue({ ...pastDue, is_completed: false, dismissed_at: null })).toBe(true)
    expect(isDeadlineOverdue({ ...pastDue, is_completed: true, dismissed_at: null })).toBe(false)
    expect(isDeadlineOverdue({ ...pastDue, is_completed: false, dismissed_at: '2026-11-01T10:00:00Z' })).toBe(false)
  })

  it('the attention list reads through the same rule', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await getDeadlinesNeedingAttention(supabase as never, 'company-1')

    expect(findCalls('deadlines', 'eq')).toContainEqual(['is_completed', false])
    expect(findCalls('deadlines', 'is')).toEqual([['dismissed_at', null]])
  })
})
