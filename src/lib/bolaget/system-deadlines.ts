/**
 * One system reminder row in `deadlines`, keyed by source_key, the way the
 * Bolaget registers keep their reminders (the pattern of
 * lib/arkiv/agreements/store.ts): inserted once, its date, title, priority
 * and notes kept in step while nobody has completed or dismissed it. The
 * capital events (capital/deadlines.ts) and the meetings (meetings/store.ts)
 * both write through here. The caller passes the service-role client and
 * the row it read, and decides what a failed write means.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { daysBetweenIso } from '@/lib/dates/iso'

/** Upcoming more than two weeks out, action needed within two weeks, overdue once passed (the status engine's thresholds). */
export function initialDeadlineStatus(dueOn: string, today: string): 'upcoming' | 'action_needed' | 'overdue' {
  const days = daysBetweenIso(today, dueOn)
  if (days < 0) return 'overdue'
  return days <= 14 ? 'action_needed' : 'upcoming'
}

export interface SystemDeadlineDraft {
  sourceKey: string
  title: string
  dueOn: string
  notes: string
  priority: 'critical' | 'important' | 'normal'
}

/** The columns of the existing row a write compares against. */
export interface SystemDeadlineRow {
  id: string
  due_date: string
  title: string
  is_completed: boolean
  dismissed_at: string | null
  status: string
}

/**
 * Insert the reminder when `row` is null, otherwise move its date, title,
 * priority and notes to the draft's. A person's completion or opt-out
 * stands. Throws on a failed write.
 */
export async function writeSystemDeadline(
  service: SupabaseClient,
  companyId: string,
  draft: SystemDeadlineDraft,
  row: SystemDeadlineRow | null,
  today: string,
  now: string,
): Promise<void> {
  if (!row) {
    const { error } = await service.from('deadlines').insert({
      company_id: companyId,
      user_id: null,
      title: draft.title,
      due_date: draft.dueOn,
      deadline_type: 'other',
      priority: draft.priority,
      is_completed: false,
      source: 'system',
      status: initialDeadlineStatus(draft.dueOn, today),
      status_changed_at: now,
      notes: draft.notes,
      is_auto_generated: true,
      reminder_offsets: [14, 7, 1, 0],
      source_key: draft.sourceKey,
    })
    if (error) throw new Error(`deadline insert failed: ${error.message}`)
    return
  }
  if (row.is_completed || row.dismissed_at) return
  if (row.due_date === draft.dueOn && row.title === draft.title) return
  // A moved date gets its status recomputed unless a person is working on it.
  const recompute = row.due_date !== draft.dueOn && ['upcoming', 'action_needed', 'overdue'].includes(row.status)
  const { error } = await service
    .from('deadlines')
    .update({
      title: draft.title,
      due_date: draft.dueOn,
      priority: draft.priority,
      notes: draft.notes,
      status: recompute ? initialDeadlineStatus(draft.dueOn, today) : row.status,
      status_changed_at: recompute ? now : undefined,
    })
    .eq('id', row.id)
  if (error) throw new Error(`deadline update failed: ${error.message}`)
}
