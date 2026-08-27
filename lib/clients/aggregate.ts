/**
 * Pure aggregation helpers for the byrå cockpit client list (WL-14).
 *
 * The fetch layer (lib/clients/fetch-client-overview.ts) runs a handful of
 * grouped queries across all client companies; everything that can be
 * computed without I/O lives here so it is unit-testable: per-company
 * counting, next-deadline selection with the 14-day ACTION_NEEDED semantics
 * from lib/deadlines/status-engine.ts, and the urgency sort (overdue
 * deadlines first, then largest unbooked pile).
 */

import {
  ACTION_NEEDED_THRESHOLD_DAYS,
  daysUntilDeadline,
} from '@/lib/deadlines/status-engine'

export type DeadlineUrgency = 'overdue' | 'action_needed' | 'upcoming'

export interface ClientDeadline {
  title: string
  dueDate: string
  taxDeadlineType: string | null
  urgency: DeadlineUrgency
}

export interface ClientOverviewRow {
  companyId: string
  name: string
  orgNumber: string | null
  /** Canonical "att bokföra" count (lib/worklist book_transaction predicate). */
  unbookedCount: number
  /** Unconsumed inbox documents (lib/worklist inbox_document predicate). */
  inboxCount: number
  nextDeadline: ClientDeadline | null
  /** Latest posted verifikat date; null = nothing booked yet. */
  lastBookedDate: string | null
}

/** Count rows per company_id from a flat grouped-query result. */
export function countByCompany(rows: Array<{ company_id: string }>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    counts.set(row.company_id, (counts.get(row.company_id) ?? 0) + 1)
  }
  return counts
}

export interface DeadlineRowInput {
  company_id: string
  title: string
  due_date: string
  tax_deadline_type: string | null
  status: string
}

/**
 * Deadline urgency per the status engine: `overdue` status (or a passed due
 * date the cron has not swept yet) flags overdue; within the 14-day
 * ACTION_NEEDED window flags action_needed; everything else is upcoming.
 * Computing from the due date as well as the stored status keeps the cockpit
 * honest between cron runs.
 */
export function deadlineUrgency(row: Pick<DeadlineRowInput, 'due_date' | 'status'>): DeadlineUrgency {
  const days = daysUntilDeadline(row.due_date)
  if (row.status === 'overdue' || days < 0) return 'overdue'
  if (row.status === 'action_needed' || days <= ACTION_NEEDED_THRESHOLD_DAYS) {
    return 'action_needed'
  }
  return 'upcoming'
}

/**
 * Pick each company's next deadline (earliest due date) from a flat list of
 * open deadlines. Input does not need to be pre-sorted.
 */
export function pickNextDeadlines(rows: DeadlineRowInput[]): Map<string, ClientDeadline> {
  const next = new Map<string, { dueDate: string; row: DeadlineRowInput }>()
  for (const row of rows) {
    const current = next.get(row.company_id)
    if (!current || row.due_date < current.dueDate) {
      next.set(row.company_id, { dueDate: row.due_date, row })
    }
  }
  const result = new Map<string, ClientDeadline>()
  for (const [companyId, { row }] of next) {
    result.set(companyId, {
      title: row.title,
      dueDate: row.due_date,
      taxDeadlineType: row.tax_deadline_type,
      urgency: deadlineUrgency(row),
    })
  }
  return result
}

/**
 * Urgency sort per the WL-14 resolution: companies with an OVERDUE deadline
 * first (earliest due date wins within the band), then everyone else by
 * unbooked count descending. Name is the stable tie-break so the list does
 * not jitter between renders.
 */
export function sortClientRows(rows: ClientOverviewRow[]): ClientOverviewRow[] {
  const byName = (a: ClientOverviewRow, b: ClientOverviewRow) =>
    a.name.localeCompare(b.name, 'sv')

  return [...rows].sort((a, b) => {
    const aOverdue = a.nextDeadline?.urgency === 'overdue'
    const bOverdue = b.nextDeadline?.urgency === 'overdue'
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
    if (aOverdue && bOverdue) {
      const byDue = a.nextDeadline!.dueDate.localeCompare(b.nextDeadline!.dueDate)
      if (byDue !== 0) return byDue
    }
    if (a.unbookedCount !== b.unbookedCount) return b.unbookedCount - a.unbookedCount
    return byName(a, b)
  })
}

/** Case-insensitive free-text filter on name and org number. */
export function filterClientRows(rows: ClientOverviewRow[], query: string): ClientOverviewRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const qDigits = q.replace(/[^0-9]/g, '')
  return rows.filter((row) => {
    if (row.name.toLowerCase().includes(q)) return true
    const org = row.orgNumber ?? ''
    if (org.toLowerCase().includes(q)) return true
    // "5560-1257" should match "5560125790": compare digits to digits.
    return qDigits.length > 0 && org.replace(/[^0-9]/g, '').includes(qDigits)
  })
}
