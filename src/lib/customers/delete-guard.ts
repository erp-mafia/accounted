/**
 * Whether a customer may be hard-deleted (crm#263).
 *
 * invoices.customer_id, sales_orders.customer_id, projects.customer_id and
 * deadlines.customer_id are all ON DELETE SET NULL, so the database lets a
 * customer go and quietly strips it from everything that pointed at it. For
 * invoices that loses the buyer: an invoice row stores no copy of the
 * customer's name or address, so the customer record is where the buyer
 * named on the invoice lives (ML 17 kap 24 §, BFL 7 kap 2 §). A draft left
 * behind without a customer can no longer be sent, and a sales order can no
 * longer be invoiced.
 *
 * The rule, Fortnox-like: a customer that any invoice row (every document
 * type, drafts included), sales order or recurring invoice points at is not
 * deleted. Projects and deadlines keep SET NULL on purpose: they stay whole
 * records without the customer link.
 *
 * Checked in the application before the delete, which leaves a window of
 * milliseconds in which a concurrent insert can still be orphaned. Recurring
 * schedules are ON DELETE RESTRICT already; they are counted here so the
 * refusal can say what to remove instead of surfacing a bare 23503.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type CustomerDeleteBlockCode =
  /** A numbered or non-draft invoice row: kept, so the customer is kept. */
  | 'CUSTOMER_HAS_ISSUED_INVOICES'
  /** Only unnumbered drafts: deleting them first frees the customer. */
  | 'CUSTOMER_HAS_DRAFT_INVOICES'
  | 'CUSTOMER_HAS_SALES_ORDERS'
  | 'CUSTOMER_HAS_RECURRING_INVOICES'

export interface CustomerDependents {
  /**
   * Invoice rows that stay for good: anything that left draft, plus numbered
   * drafts, which are makulerade (status cancelled, number kept) rather than
   * deleted (lib/invoices/delete-draft-invoice.ts).
   */
  issued_invoices: number
  /** Unnumbered drafts: the only invoice rows a delete removes. */
  draft_invoices: number
  sales_orders: number
  recurring_invoice_schedules: number
}

export type CustomerDeleteCheck =
  | { deletable: true; dependents: CustomerDependents }
  | { deletable: false; code: CustomerDeleteBlockCode; dependents: CustomerDependents }

/**
 * The refusal for a set of dependents, or null when nothing points at the
 * customer. The permanent reason comes first: telling someone to delete
 * their drafts is pointless when an issued invoice keeps the customer anyway.
 */
export function customerDeleteBlocker(dependents: CustomerDependents): CustomerDeleteBlockCode | null {
  if (dependents.issued_invoices > 0) return 'CUSTOMER_HAS_ISSUED_INVOICES'
  if (dependents.draft_invoices > 0) return 'CUSTOMER_HAS_DRAFT_INVOICES'
  if (dependents.sales_orders > 0) return 'CUSTOMER_HAS_SALES_ORDERS'
  if (dependents.recurring_invoice_schedules > 0) return 'CUSTOMER_HAS_RECURRING_INVOICES'
  return null
}

/**
 * Counts what points at the customer and says whether it may be deleted.
 * Throws the database error when a count fails: refusing to judge is safer
 * than deleting on a guess.
 */
export async function checkCustomerDeletable(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string,
): Promise<CustomerDeleteCheck> {
  const count = (table: string) =>
    supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('customer_id', customerId)

  const [issued, drafts, orders, schedules] = await Promise.all([
    count('invoices').or('status.neq.draft,invoice_number.not.is.null'),
    count('invoices').eq('status', 'draft').is('invoice_number', null),
    count('sales_orders'),
    count('recurring_invoice_schedules'),
  ])

  for (const result of [issued, drafts, orders, schedules]) {
    if (result.error) throw result.error
  }

  const dependents: CustomerDependents = {
    issued_invoices: issued.count ?? 0,
    draft_invoices: drafts.count ?? 0,
    sales_orders: orders.count ?? 0,
    recurring_invoice_schedules: schedules.count ?? 0,
  }
  const code = customerDeleteBlocker(dependents)
  return code ? { deletable: false, code, dependents } : { deletable: true, dependents }
}
