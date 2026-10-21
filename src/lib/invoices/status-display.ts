import type { InvoiceStatus } from '@/types'
import { OVERDUE_CHIP, type StatusChip, type StatusDisplay } from '@/lib/status-display'
import { isUnsentNumberedInvoice } from './invoice-list-tabs'
import { invoiceDaysOverdue, isInvoiceOverdue, type OverdueInvoiceInput } from './overdue'
import { quoteDisplayStatus } from './quote-status'

/**
 * A customer invoice's status as every surface shows it: the invoice list
 * and detail, the customer page, the sales order and the transaction
 * invoice picker. Labels live in the `invoices` namespace.
 *
 * Sent and paid are the normal path and read as muted text; the rest
 * deviate and get a chip. invoiceRowStatus below adds what the row itself
 * says (a credit note, an unsent number, the paid date, the days overdue);
 * the list adds what only it knows (a collection case, a failed Peppol
 * delivery) on top of that.
 */
const INVOICE_STATUS_DISPLAY: Record<InvoiceStatus, StatusDisplay> = {
  draft: { labelKey: 'status_draft', chip: 'secondary' },
  sent: { labelKey: 'status_sent', chip: null },
  paid: { labelKey: 'status_paid', chip: null },
  partially_paid: { labelKey: 'status_partially_paid', chip: 'warning' },
  overdue: { labelKey: 'status_overdue', chip: OVERDUE_CHIP },
  cancelled: { labelKey: 'status_cancelled', chip: 'secondary' },
  credited: { labelKey: 'status_credited', chip: 'secondary' },
  // A konstaterad kundförlust (lib/customer-loss): the claim left 1510.
  written_off: { labelKey: 'status_written_off', chip: 'destructive' },
}

/** Null for a status this build does not know, so the caller can show the raw value. */
export function invoiceStatusDisplay(status: string): StatusDisplay | null {
  return INVOICE_STATUS_DISPLAY[status as InvoiceStatus] ?? null
}

export const INVOICE_STATUSES = Object.keys(INVOICE_STATUS_DISPLAY) as InvoiceStatus[]

/** The facts of an invoice row its status line reads. */
export interface InvoiceRowStatusInput extends OverdueInvoiceInput {
  invoice_number?: string | null
  is_self_billed?: boolean | null
  quote_status?: string | null
  valid_until?: string | null
  paid_at?: string | null
}

/**
 * Which state the row is in. The payment-flow kinds (paid, partially_paid,
 * overdue, sent) are the ones the invoice list may overrule with a
 * collection case or a failed Peppol delivery.
 */
export type InvoiceRowStatusKind =
  | 'cancelled'
  | 'credit_note'
  | 'credited'
  | 'written_off'
  | 'quote'
  | 'unsent'
  | 'draft'
  | 'paid'
  | 'partially_paid'
  | 'overdue'
  | 'sent'
  | 'unknown'

export interface InvoiceRowStatus {
  kind: InvoiceRowStatusKind
  /** The label's key in the `invoices` namespace; null for a status this build does not know. */
  labelKey: string | null
  /** The label's values: `days` for the days overdue, `date` (YYYY-MM-DD, for the caller to format) for the paid date. */
  values?: { days: number } | { date: string }
  chip: StatusChip | null
}

function fromDisplay(kind: InvoiceRowStatusKind, status: InvoiceStatus): InvoiceRowStatus {
  const display = INVOICE_STATUS_DISPLAY[status]
  return { kind, labelKey: display.labelKey, chip: display.chip }
}

/**
 * The status line of one invoice row, the same in the invoice list and on
 * the customer card (crm#1084): overdue follows the due date and the open
 * remainder (lib/invoices/overdue.ts), never the stored status alone.
 */
export function invoiceRowStatus(invoice: InvoiceRowStatusInput, today?: string): InvoiceRowStatus {
  const isCreditNote = !!invoice.credited_invoice_id
  if (invoice.status === 'cancelled') return fromDisplay('cancelled', 'cancelled')
  if (isCreditNote && invoice.status !== 'paid') {
    return { kind: 'credit_note', labelKey: 'badge_credit', chip: 'destructive' }
  }
  if (invoice.status === 'credited') return fromDisplay('credited', 'credited')
  // A konstaterad kundförlust closes the claim: never in the payment flow.
  if (invoice.status === 'written_off') return fromDisplay('written_off', 'written_off')
  // Offert: the decision (or derived expiry) is the status. Open and
  // accepted are the normal states; declined, expired and an open quote
  // that was never sent (crm#1202) deviate.
  const quoteStatus = invoice.document_type === 'quote' ? quoteDisplayStatus(invoice, today) : null
  if (quoteStatus === 'unsent') return { kind: 'quote', labelKey: 'status_unsent', chip: 'outline' }
  if (quoteStatus === 'expired') return { kind: 'quote', labelKey: 'quote_status_expired', chip: 'warning' }
  if (quoteStatus === 'declined') return { kind: 'quote', labelKey: 'quote_status_declined', chip: 'secondary' }
  if (quoteStatus === 'accepted') return { kind: 'quote', labelKey: 'quote_status_accepted', chip: null }
  if (quoteStatus === 'open') return { kind: 'quote', labelKey: 'quote_status_open', chip: null }
  if (invoice.status === 'draft') {
    const unsent = isUnsentNumberedInvoice({
      status: 'draft',
      invoice_number: invoice.invoice_number ?? null,
      credited_invoice_id: invoice.credited_invoice_id ?? null,
      document_type: invoice.document_type,
      is_self_billed: invoice.is_self_billed,
    })
    return unsent
      ? { kind: 'unsent', labelKey: 'status_unsent', chip: 'outline' }
      : fromDisplay('draft', 'draft')
  }
  if (invoice.status === 'paid') {
    return invoice.paid_at
      ? { kind: 'paid', labelKey: 'status_paid_date', values: { date: invoice.paid_at }, chip: null }
      : fromDisplay('paid', 'paid')
  }
  // A partly paid invoice reads as partly paid first, overdue or not.
  if (invoice.status === 'partially_paid') return fromDisplay('partially_paid', 'partially_paid')
  if (invoice.status === 'sent' || invoice.status === 'overdue') {
    if (isInvoiceOverdue(invoice, today) && invoice.due_date) {
      return {
        kind: 'overdue',
        labelKey: 'status_overdue_days',
        values: { days: invoiceDaysOverdue(invoice.due_date, today) },
        chip: OVERDUE_CHIP,
      }
    }
    return fromDisplay('sent', 'sent')
  }
  return { kind: 'unknown', labelKey: null, chip: null }
}
