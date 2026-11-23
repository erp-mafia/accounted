/**
 * "Attested" and "overdue" for a supplier invoice, as every list and filter
 * reports them (for #207).
 *
 * The stored status holds one word, and the nightly flip
 * (update_overdue_supplier_invoices) writes 'overdue' over both 'registered'
 * and 'approved'. A reader of the status alone therefore lost every attested
 * invoice the day after its due date (the Attesterade tab, status=approved in
 * the API and for the agent), and never saw a part-paid invoice as overdue
 * (its status stays 'partially_paid'). Both facts are read here from what
 * they hang on instead: the attest mark, and the due date with money left.
 *
 * One invoice can be both: attested and past due. It is then in the attested
 * set and in the overdue set, and its `status` field still reads 'overdue'.
 */

import { todayIsoStockholm } from '@/lib/dates/iso'
import { ISO_DATE_RE } from '@/lib/invariants'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import {
  isOverduePayable,
  isUnsettledSupplierInvoiceStatus,
  UNSETTLED_SUPPLIER_INVOICE_STATUSES,
} from './lifecycle'

/**
 * "Nothing left to pay", the threshold isOverduePayable and the nightly flip
 * read (lifecycle.ts FULLY_PAID_EPSILON), as the query below needs it.
 */
const NOTHING_LEFT_EPSILON = 0.005

/**
 * The attest fact: the invoice carries an attest. Two shapes say so.
 * approved_at is the mark the attest service sets, and nothing clears it:
 * there is no un-attest, a rejection is only possible before the mark, and
 * the overdue flip, a due date edit and a payment undo all leave it alone.
 * The stored status 'approved' without a mark is the other shape: rows
 * inserted as 'approved', and rows a payment undo or an undone credit rested
 * there before both asked resolveUnsettledStatus (crm#2121). From there an
 * invoice can no longer be attested (canApproveSupplierInvoice refuses
 * 'approved'), so it is past the attest step for every reader.
 */
export function isSupplierInvoiceAttested(invoice: { status: string; approved_at?: string | null }): boolean {
  return !!invoice.approved_at || invoice.status === 'approved'
}

/**
 * Attesterade: attested and nothing paid yet, whatever the due date did to
 * the stored status. The rule of the Attesterade tab and of status=approved
 * in the dashboard list, the v1 API and the agent's list. A part-paid, paid,
 * credited, reversed or disputed invoice has left this step.
 */
export function isAttestedAwaitingPayment(invoice: { status: string; approved_at?: string | null }): boolean {
  return isUnsettledSupplierInvoiceStatus(invoice.status) && isSupplierInvoiceAttested(invoice)
}

/**
 * The statuses an overdue invoice can rest in: the ones a payment can still
 * be made for (PAYABLE_SUPPLIER_INVOICE_STATUSES). A part-paid invoice keeps
 * its status and is overdue on what is left. A disputed one is held back on
 * purpose and is not reported as overdue.
 */
const CAN_BE_OVERDUE: ReadonlySet<string> = new Set(PAYABLE_SUPPLIER_INVOICE_STATUSES)

/**
 * Overdue: a payable with money left whose due date has passed
 * (isOverduePayable, the predicate of the nightly flip), in a status that can
 * still be paid. Computed, so it holds for a part-paid invoice and in the
 * hours before the flip, and it ends the moment the due date moves or the
 * last payment lands. The stored status 'overdue' is one of the statuses it
 * is read in, never the fact itself.
 */
export function isSupplierInvoiceOverdue(
  invoice: { status: string; due_date?: string | null; remaining_amount?: number | null; is_credit_note?: boolean | null },
  today: string = todayIsoStockholm(),
): boolean {
  if (!CAN_BE_OVERDUE.has(invoice.status) || !invoice.due_date) return false
  return isOverduePayable(
    {
      due_date: invoice.due_date,
      remaining_amount: Number(invoice.remaining_amount ?? 0),
      is_credit_note: invoice.is_credit_note,
    },
    today,
  )
}

/**
 * The PostgREST filters the status filter needs. The helper takes any builder
 * that has them and hands the same builder type back; the constraint names
 * the methods only (checking full signatures against a PostgrestFilterBuilder
 * makes tsc give up, as in lib/invoices/overdue.ts).
 */
interface StatusFilterQuery {
  in(column: string, values: readonly string[]): StatusFilterQuery
  eq(column: string, value: string | boolean): StatusFilterQuery
  gt(column: string, value: number): StatusFilterQuery
  lt(column: string, value: string): StatusFilterQuery
  or(filters: string): StatusFilterQuery
}

type FilterableQuery = { [K in keyof StatusFilterQuery]: unknown }

/**
 * Narrows a `supplier_invoices` query to one reported status. 'approved' is
 * the rows isAttestedAwaitingPayment accepts and 'overdue' the rows
 * isSupplierInvoiceOverdue accepts; every other status is the stored one, so
 * no other filter changes what it returns. The dashboard list route, the v1
 * list and the agent's list all read this.
 */
export function filterSupplierInvoicesByReportedStatus<Q extends FilterableQuery>(
  query: Q,
  status: string,
  today: string = todayIsoStockholm(),
): Q {
  const builder = query as unknown as StatusFilterQuery
  if (status === 'approved') {
    // Unsettled, and attested in either shape. One flat `or` beside the `in`
    // (a nested and() inside or() is avoided, as in lib/invoices/overdue.ts).
    return builder
      .in('status', UNSETTLED_SUPPLIER_INVOICE_STATUSES)
      .or('status.eq.approved,approved_at.not.is.null') as unknown as Q
  }
  if (status === 'overdue') {
    // Interpolated into the request's filter, so it has to be a date.
    if (!ISO_DATE_RE.test(today)) throw new Error(`supplier invoice overdue filter: invalid date ${JSON.stringify(today)}`)
    // is_credit_note is NOT NULL (migration 20240101000025), so eq is exact.
    return builder
      .in('status', PAYABLE_SUPPLIER_INVOICE_STATUSES)
      .eq('is_credit_note', false)
      .gt('remaining_amount', NOTHING_LEFT_EPSILON)
      .lt('due_date', today) as unknown as Q
  }
  return builder.eq('status', status) as unknown as Q
}
