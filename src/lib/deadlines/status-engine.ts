/**
 * Status engine for deadline status transitions
 *
 * Status flow:
 * upcoming ──(14d före)──> action_needed ──(manuell)──> in_progress
 *                               │                            │
 *                               │                      ──(manuell)──> submitted ──> confirmed
 *                               │
 *                          (passerad)
 *                               │
 *                               v
 *                            overdue
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { addDaysIso, daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { filterOpenDeadlines } from '@/lib/deadlines/open'

const log = createLogger('deadline-status')

/**
 * Number of days before deadline when status changes to action_needed
 */
export const ACTION_NEEDED_THRESHOLD_DAYS = 14

/**
 * Whole calendar days from today (the Swedish calendar day) to a deadline.
 * Counted on dates, not clock time: a millisecond difference rounded up
 * counted 14 days as 15 when the autumn DST change fell in between.
 */
export function daysUntilDeadline(dueDate: string, now: Date = new Date()): number {
  return daysBetweenIso(todayIsoStockholm(now), dueDate.slice(0, 10))
}

/**
 * Update deadline statuses automatically (called by daily cron)
 */
export async function updateDeadlineStatuses(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<{ updated: number; newlyOverdue: number; newlyActionNeeded: number }> {
  // Both bounds are Swedish calendar days: a deadline due today turns
  // overdue on the Swedish day after, whatever the UTC date says.
  const todayStr = todayIsoStockholm(now)
  const thresholdStr = addDaysIso(todayStr, ACTION_NEEDED_THRESHOLD_DAYS)

  let updated = 0
  let newlyOverdue = 0
  let newlyActionNeeded = 0

  // 1. Mark overdue: past deadline, not completed, not submitted/confirmed
  const { data: overdueDeadlines, error: overdueError } = await supabase
    .from('deadlines')
    .update({
      status: 'overdue',
      status_changed_at: new Date().toISOString(),
    })
    .lt('due_date', todayStr)
    .eq('is_completed', false)
    .is('dismissed_at', null)
    .in('status', ['upcoming', 'action_needed'])
    .select('id')

  if (overdueError) {
    log.error('Error updating overdue deadlines:', overdueError)
  } else {
    newlyOverdue = overdueDeadlines?.length || 0
    updated += newlyOverdue
  }

  // 2. Mark action_needed: within threshold, currently upcoming
  const { data: actionNeededDeadlines, error: actionNeededError } = await supabase
    .from('deadlines')
    .update({
      status: 'action_needed',
      status_changed_at: new Date().toISOString(),
    })
    .gte('due_date', todayStr)
    .lte('due_date', thresholdStr)
    .eq('status', 'upcoming')
    .eq('is_completed', false)
    .is('dismissed_at', null)
    .select('id')

  if (actionNeededError) {
    log.error('Error updating action_needed deadlines:', actionNeededError)
  } else {
    newlyActionNeeded = actionNeededDeadlines?.length || 0
    updated += newlyActionNeeded
  }

  return { updated, newlyOverdue, newlyActionNeeded }
}

/**
 * Get deadlines that need attention (action_needed or overdue)
 */
export async function getDeadlinesNeedingAttention(
  supabase: SupabaseClient,
  companyId: string
): Promise<{
  actionNeeded: Array<{ id: string; title: string; due_date: string; tax_deadline_type: string | null }>
  overdue: Array<{ id: string; title: string; due_date: string; tax_deadline_type: string | null }>
}> {
  const { data: deadlines, error } = await filterOpenDeadlines(
    supabase
      .from('deadlines')
      .select('id, title, due_date, tax_deadline_type, status')
      .eq('company_id', companyId),
  )
    .in('status', ['action_needed', 'overdue'])
    .order('due_date', { ascending: true })

  if (error) {
    log.error('Error fetching deadlines needing attention:', error)
    return { actionNeeded: [], overdue: [] }
  }

  const actionNeeded = deadlines?.filter((d) => d.status === 'action_needed') || []
  const overdue = deadlines?.filter((d) => d.status === 'overdue') || []

  return { actionNeeded, overdue }
}
