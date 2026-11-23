/**
 * The status an unsettled supplier invoice rests at, and the 'overdue'
 * predicate it reads. In the ledger kernel so the payment sync
 * (payment-sync.ts) reads the same rule as the supplier-invoices block
 * (lib/supplier-invoices/lifecycle.ts re-exports all of it).
 *
 * 'overdue' is derived state (an unpaid payable past its due date) that we
 * store as a lifecycle status: the daily pg_cron job
 * update_overdue_supplier_invoices() flips 'registered'/'approved' rows there.
 * Because it is stored rather than computed, every path that can change
 * due_date, or that gates on the status, has to use the same predicate as the
 * cron. When they diverge the label sticks: before #1206 nothing ever flipped
 * back, so an unbooked invoice that aged past its due date became read-only
 * and could not even have its due date extended.
 *
 * Keep this file in sync with update_overdue_supplier_invoices()
 * (supabase/migrations/20261101120100_stockholm_today.sql).
 * The SQL also skips migration-reset archives, whose rows are frozen; that is
 * a company-level guard, not part of this row-level predicate.
 *
 * Dependency-free on purpose (lib/dates only): client components import it
 * through lifecycle.ts.
 */

import { isPastDue } from '@/lib/dates/iso'

/**
 * "Nothing left to pay" threshold, mirroring the cron and the payment/match
 * paths: öre-level rounding must not leave a payable looking unsettled.
 */
export const FULLY_PAID_EPSILON = 0.005

/**
 * Statuses the overdue flip/un-flip owns. They are also exactly the statuses
 * in which an invoice is still unsettled, so metadata editing is allowed:
 * 'paid'/'partially_paid'/'credited'/'reversed'/'disputed' are settled or
 * disputed states that other flows own.
 */
export const UNSETTLED_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'overdue',
] as const

export type UnsettledSupplierInvoiceStatus =
  (typeof UNSETTLED_SUPPLIER_INVOICE_STATUSES)[number]

/** The facts the overdue predicate reads. `today` is an ISO yyyy-MM-dd date. */
export type SupplierInvoiceLifecycleFacts = {
  due_date: string
  remaining_amount: number
  is_credit_note?: boolean | null
  /** Set when the invoice has been attested; null/undefined when it has not. */
  approved_at?: string | null
}

/**
 * True when the invoice is a payable that has fallen due: the exact predicate
 * update_overdue_supplier_invoices() flips on. Credit notes are not payables,
 * and a fully settled row has nothing to fall due.
 */
export function isOverduePayable(
  facts: Pick<SupplierInvoiceLifecycleFacts, 'due_date' | 'remaining_amount' | 'is_credit_note'>,
  today: string,
): boolean {
  if (facts.is_credit_note) return false
  if (facts.remaining_amount <= FULLY_PAID_EPSILON) return false
  return isPastDue(facts.due_date, today)
}

/**
 * The status an unsettled invoice should rest at right now. The one
 * definition (scripts/checks/one-definition/supplier-invoice-rest-status.mjs):
 * every TypeScript door that puts an invoice back here asks it, an undone
 * payment and an undone credit included, and the SQL undo paths and the
 * overdue cron mirror it.
 *
 * The flip collapses 'registered' and 'approved' into 'overdue', so the way
 * back needs approved_at: without it an un-flip would silently strip an
 * attested invoice of its approval (and with it the "Markera som betald"
 * path). Rows that were already 'overdue' when approved_at was introduced
 * carry no timestamp and therefore return to 'registered', where they can be
 * re-approved.
 */
export function resolveUnsettledStatus(
  facts: SupplierInvoiceLifecycleFacts,
  today: string,
): UnsettledSupplierInvoiceStatus {
  if (isOverduePayable(facts, today)) return 'overdue'
  return facts.approved_at ? 'approved' : 'registered'
}
