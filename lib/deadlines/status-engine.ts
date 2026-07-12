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
import type { DeadlineStatus } from '@/types'

const log = createLogger('deadline-status')

/**
 * Number of days before deadline when status changes to action_needed
 */
export const ACTION_NEEDED_THRESHOLD_DAYS = 14

/**
 * Valid manual status transitions
 */
export const MANUAL_TRANSITIONS: Record<DeadlineStatus, DeadlineStatus[]> = {
  upcoming: ['action_needed', 'in_progress'],
  action_needed: ['in_progress', 'submitted'],
  in_progress: ['submitted', 'action_needed'],
  submitted: ['confirmed', 'in_progress'],
  confirmed: [], // Terminal state
  overdue: ['in_progress', 'submitted'], // Can recover from overdue
}

/**
 * Check if a manual status transition is valid
 */
export function isValidTransition(
  currentStatus: DeadlineStatus,
  newStatus: DeadlineStatus
): boolean {
  return MANUAL_TRANSITIONS[currentStatus].includes(newStatus)
}

/**
 * Calculate days until a deadline
 */
export function daysUntilDeadline(dueDate: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const deadline = new Date(dueDate)
  deadline.setHours(0, 0, 0, 0)
  return Math.ceil((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
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
 * Manually update a deadline's status
 */
export async function updateDeadlineStatus(
  supabase: SupabaseClient,
  deadlineId: string,
  companyId: string,
  newStatus: DeadlineStatus
): Promise<{ success: boolean; error?: string }> {
  // Fetch current deadline
  const { data: deadline, error: fetchError } = await supabase
    .from('deadlines')
    .select('status, is_completed')
    .eq('id', deadlineId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !deadline) {
    return { success: false, error: 'Deadline not found' }
  }

  // Check if transition is valid
  if (!isValidTransition(deadline.status, newStatus)) {
    return {
      success: false,
      error: `Invalid transition from ${deadline.status} to ${newStatus}`,
    }
  }

  // Update the status
  const updates: Record<string, unknown> = {
    status: newStatus,
    status_changed_at: new Date().toISOString(),
  }

  // If marking as confirmed, also mark as completed
  if (newStatus === 'confirmed') {
    updates.is_completed = true
    updates.completed_at = new Date().toISOString()
  }

  const { error: updateError } = await supabase
    .from('deadlines')
    .update(updates)
    .eq('id', deadlineId)
    .eq('company_id', companyId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  return { success: true }
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
