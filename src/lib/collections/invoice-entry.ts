import type { CollectionsAction, CollectionsStage } from '@accounted/connect-contract'
import type { CollectionsStartState } from './flags'
import { NOT_STARTED_STAGES, isInCollectionStage } from './stages'

/**
 * Where collections shows up on the invoice page (build spec 3.1, 3.4,
 * 3.5), pure and client-safe: whether "Skicka till inkasso" is offered, and
 * what the Påminnelser card says about who reminds the customer.
 */

/** Statuses of an invoice the customer still owes. */
const OWED_STATUSES: ReadonlySet<string> = new Set(['sent', 'overdue', 'partially_paid'])

export interface EntryInvoice {
  status: string
  /** YYYY-MM-DD. */
  due_date: string | null
  remaining_amount?: number | null
}

export interface EntryCase {
  stage: CollectionsStage
  isOpen: boolean
  submissionStatus: string
  actions: readonly CollectionsAction[]
}

/** The invoice is owed and its due date has passed (Stockholm date, never `status = 'overdue'`). */
export function isOverdueUnpaid(invoice: EntryInvoice, today: string): boolean {
  if (!OWED_STATUSES.has(invoice.status)) return false
  if (typeof invoice.remaining_amount === 'number' && invoice.remaining_amount <= 0) return false
  return !!invoice.due_date && invoice.due_date < today
}

/**
 * "Skicka till inkasso" in the invoice's menu: an overdue, unpaid invoice
 * while the start entry points are not hidden (upgrade and activate open
 * the dialog with their note), with no open case, or with a claim the
 * provider only delivered and offers to start. Eligibility beyond that is
 * the dialog's checklist, never a silently missing item.
 */
export function showSendToCollection(input: {
  invoice: EntryInvoice
  start: CollectionsStartState
  openCase: EntryCase | null
  today: string
}): boolean {
  if (input.start === 'hidden') return false
  if (!isOverdueUnpaid(input.invoice, input.today)) return false
  const open = input.openCase?.isOpen ? input.openCase : null
  if (!open) return true
  return open.submissionStatus === 'registered' && NOT_STARTED_STAGES.has(open.stage) && open.actions.includes('start')
}

/** What the Påminnelser card says about reminders while collections is in play; null keeps its own aside. */
export function remindersAside(input: {
  invoice: Pick<EntryInvoice, 'status'>
  connection: { state: string; ladderMode: 'off' | 'staged' | null; ladderDaysAfterDue: number | null } | null
  openCase: Pick<EntryCase, 'stage' | 'isOpen'> | null
}): { key: 'reminders_by_provider' } | { key: 'reminders_none' } | { key: 'reminders_batch'; days: number } | null {
  const open = input.openCase?.isOpen ? input.openCase : null
  if (open && isInCollectionStage(open.stage)) return { key: 'reminders_by_provider' }
  if (open || input.connection?.state !== 'active') return null
  if (!OWED_STATUSES.has(input.invoice.status)) return null
  if (input.connection.ladderMode === 'staged') {
    // Proposed for the daily batch; without its day count the card keeps its own aside.
    return input.connection.ladderDaysAfterDue === null ? null : { key: 'reminders_batch', days: input.connection.ladderDaysAfterDue }
  }
  return { key: 'reminders_none' }
}
