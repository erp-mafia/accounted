import type { InvoiceStatus } from '@/types'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'

/**
 * "Overdue" for a customer invoice is derived, never stored (crm#1084): a
 * real invoice the customer still owes money on whose due date has passed
 * (Europe/Stockholm calendar day). Nothing has to run for it to become true,
 * and extending the due date or registering the last payment ends it with
 * no status write, exactly like an expired quote (lib/invoices/quote-status).
 *
 * The stored status 'overdue' is legacy: the reminder run used to write it
 * after sending a reminder (gone since 2026-10-12), a payment storno past the
 * due date and the provider importers still do. It is read here as one more
 * owed status, never as the overdue fact itself, so a stored label can
 * neither keep an invoice "Förfallen" after its due date moved nor leave an
 * unreminded one looking on time.
 *
 * Partly paid invoices with an open remainder are overdue too: the
 * remainder is past due. Their status stays 'partially_paid' everywhere (it
 * decides what may be done with them), and the overdue fact is shown next
 * to it by the views that list overdue invoices.
 *
 * A status, never a booking: nothing here touches the ledger, so
 * kontantmetoden and faktureringsmetoden read it the same way.
 */

/** Statuses of an invoice the customer still owes. */
export const OWED_INVOICE_STATUSES = ['sent', 'overdue', 'partially_paid'] as const

const OWED: ReadonlySet<string> = new Set(OWED_INVOICE_STATUSES)

export interface OverdueInvoiceInput {
  status: string
  /** YYYY-MM-DD. */
  due_date?: string | null
  /** The customer's open share; a missing value counts as still owed. */
  remaining_amount?: number | null
  /** Older rows can lack it; a missing value is 'invoice'. */
  document_type?: string | null
  /** Set on a credit note (kreditfaktura): never a receivable. */
  credited_invoice_id?: string | null
}

/** The invoice has an unpaid remainder past its due date. */
export function isInvoiceOverdue(invoice: OverdueInvoiceInput, today: string = todayIsoStockholm()): boolean {
  if (!OWED.has(invoice.status)) return false
  // Proformas, delivery notes and quotes carry a date but no receivable.
  if ((invoice.document_type || 'invoice') !== 'invoice') return false
  if (invoice.credited_invoice_id) return false
  if (typeof invoice.remaining_amount === 'number' && invoice.remaining_amount <= 0) return false
  return !!invoice.due_date && invoice.due_date < today
}

/** Whole days past the due date, at least 1 (the day after the due date is day 1). */
export function invoiceDaysOverdue(dueDate: string, today: string = todayIsoStockholm()): number {
  return Math.max(1, daysBetweenIso(dueDate, today))
}

/**
 * The status every surface reports (lists, API, MCP): 'sent' and the
 * legacy stored 'overdue' follow the due date, every other status is the
 * stored one. Every action that accepts one of the pair accepts the other,
 * so reporting either never promises an action the invoice refuses.
 */
export function effectiveInvoiceStatus(
  invoice: OverdueInvoiceInput & { status: InvoiceStatus | string },
  today: string = todayIsoStockholm(),
): string {
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') return invoice.status
  return isInvoiceOverdue(invoice, today) ? 'overdue' : 'sent'
}

/**
 * The PostgREST filters this module's queries need. The helpers take any
 * builder that has them and hand the same builder type back. The constraint
 * names the methods only: checking their full signatures against a
 * PostgrestFilterBuilder makes tsc give up (TS2589, instantiation too deep).
 */
interface InvoiceFilterQuery {
  in(column: string, values: readonly string[]): InvoiceFilterQuery
  eq(column: string, value: string): InvoiceFilterQuery
  is(column: string, value: null): InvoiceFilterQuery
  lt(column: string, value: string): InvoiceFilterQuery
  gt(column: string, value: number): InvoiceFilterQuery
  or(filters: string): InvoiceFilterQuery
}

type FilterableQuery = { [K in keyof InvoiceFilterQuery]: unknown }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertIsoDate(today: string): void {
  // Interpolated into a raw PostgREST filter string by the 'sent' branch.
  if (!ISO_DATE.test(today)) throw new Error(`invoice overdue filter: invalid date ${JSON.stringify(today)}`)
}

/**
 * Narrows an `invoices` query to the ones a customer still owes money on,
 * whatever the due date: a real faktura in an owed status with an open
 * remainder. A credit note is never owed: it carries credited_invoice_id and
 * nothing remaining, even while its status says 'sent' (crm#1435).
 */
export function filterOwedInvoices<Q extends FilterableQuery>(query: Q): Q {
  return (query as unknown as InvoiceFilterQuery)
    .in('status', OWED_INVOICE_STATUSES)
    .eq('document_type', 'invoice')
    .is('credited_invoice_id', null)
    .gt('remaining_amount', 0) as unknown as Q
}

/**
 * Narrows an `invoices` query to the overdue ones, the same rows
 * isInvoiceOverdue accepts: the owed ones past their due date. The Förfallna
 * view, the Att göra count, the Viktiga datum note and the agent's
 * status=overdue filter all read this.
 */
export function filterOverdueInvoices<Q extends FilterableQuery>(query: Q, today: string = todayIsoStockholm()): Q {
  assertIsoDate(today)
  return (filterOwedInvoices(query) as unknown as InvoiceFilterQuery).lt('due_date', today) as unknown as Q
}

/**
 * A status filter as effectiveInvoiceStatus reports it: 'overdue' is the
 * overdue set above (partly paid included, their status still says so),
 * 'sent' is a sent invoice that is not overdue, any other status is the
 * stored one.
 */
export function filterInvoicesByReportedStatus<Q extends FilterableQuery>(
  query: Q,
  status: string,
  today: string = todayIsoStockholm(),
): Q {
  if (status === 'overdue') return filterOverdueInvoices(query, today)
  const builder = query as unknown as InvoiceFilterQuery
  if (status === 'sent') {
    assertIsoDate(today)
    // The complement of filterOverdueInvoices within sent/overdue, as one
    // flat `or` (a nested and() inside or() is avoided: see
    // scopeTransactionsToAccount in lib/reconciliation/bank-reconciliation).
    return builder
      .in('status', ['sent', 'overdue'])
      .or(`document_type.neq.invoice,credited_invoice_id.not.is.null,due_date.gte.${today},remaining_amount.lte.0`) as unknown as Q
  }
  return builder.eq('status', status) as unknown as Q
}
