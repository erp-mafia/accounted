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

const log = createLogger('deadline-status')

/**
 * Number of days before deadline when status changes to action_needed
 */
export const ACTION_NEEDED_THRESHOLD_DAYS = 14

/**
 * Days since the epoch for the local calendar date of `date`. Date.UTC puts
 * the local date parts on a timeline that has no DST, where every day is
 * exactly 24 hours long, so the division is always a whole number.
 */
function localDaysSinceEpoch(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (1000 * 60 * 60 * 24)
}

/**
 * Calculate days until a deadline
 *
 * Counted in calendar days, which is what a deadline is: a date, not an
 * instant. This used to subtract two local midnights and divide by 24 hours,
 * so any span crossing a DST change came out fractional and the rounding then
 * moved the answer a whole day. In Europe/Stockholm a deadline 14 calendar
 * days out measured 14.0417 days in late October and reported 15, putting it
 * outside ACTION_NEEDED_THRESHOLD_DAYS, and a deadline one day past measured
 * -0.9583 days in late March and reported 0, reading as due today instead of
 * overdue.
 */
export function daysUntilDeadline(dueDate: string): number {
  return localDaysSinceEpoch(new Date(dueDate)) - localDaysSinceEpoch(new Date())
}

/**
 * Update deadline statuses automatically (called by daily cron)
 */
export async function updateDeadlineStatuses(
  supabase: SupabaseClient
): Promise<{ updated: number; newlyOverdue: number; newlyActionNeeded: number }> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().split('T')[0]

  // Calculate the action_needed threshold date
  const thresholdDate = new Date(today)
  thresholdDate.setDate(thresholdDate.getDate() + ACTION_NEEDED_THRESHOLD_DAYS)
  const thresholdStr = thresholdDate.toISOString().split('T')[0]

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
  const { data: deadlines, error } = await supabase
    .from('deadlines')
    .select('id, title, due_date, tax_deadline_type, status')
    .eq('company_id', companyId)
    .eq('is_completed', false)
    .is('dismissed_at', null)
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
