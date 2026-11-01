import type { SupabaseClient } from '@supabase/supabase-js'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { isMatchableInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { invoiceHasActiveCreditNote } from '@/lib/invoices/active-credit-note'
import { futurePaymentDateRefusal, type FuturePaymentDateRefusal } from '@/lib/invoices/payment-date'

export type InvoicePayableRefusal =
  | { code: 'INVOICE_QUOTE_NOT_PAYABLE'; details?: undefined }
  | { code: 'INVOICE_PAID_NOT_PAYABLE'; details: Record<string, unknown> }
  | FuturePaymentDateRefusal

/**
 * Whether a payment may be recorded on this customer document on this date,
 * the one answer of every door. settleInvoicePayment asks first, so no door
 * can skip it; a door with a dry run or a staging step asks too, and so does
 * one that runs a guard of its own in front of the booking.
 *
 *   - a kreditfaktura is paid back, not paid (each door has its refund path);
 *   - a quote is an offer, not a claim: convert it first;
 *   - a följesedel has no payment lifecycle: it carries no amount owed, and
 *     paying one flipped it to paid and told webhook subscribers invoice.paid;
 *   - only a sent, overdue or part-paid document is open. A proforma stays
 *     payable: a prepayment record with no verifikat;
 *   - a payment is dated the day the money moved (lib/invoices/payment-date.ts);
 *   - an active credit note, a draft included, takes the invoice out of payment.
 */
export async function invoicePayableRefusal(
  supabase: SupabaseClient,
  companyId: string,
  invoice: {
    id: string
    status: string
    document_type?: string | null
    credited_invoice_id?: string | null
    total?: number | string | null
  },
  paymentDate: string,
): Promise<InvoicePayableRefusal | null> {
  if (isCreditNoteDocument(invoice)) return { code: 'INVOICE_PAID_NOT_PAYABLE', details: { reason: 'credit_note' } }
  if (invoice.document_type === 'quote') return { code: 'INVOICE_QUOTE_NOT_PAYABLE' }
  if (invoice.document_type === 'delivery_note') {
    return { code: 'INVOICE_PAID_NOT_PAYABLE', details: { reason: 'delivery_note' } }
  }
  if (!isMatchableInvoiceStatus(invoice.status)) {
    return { code: 'INVOICE_PAID_NOT_PAYABLE', details: { currentStatus: invoice.status } }
  }
  const futureDate = futurePaymentDateRefusal(paymentDate)
  if (futureDate) return futureDate
  if (await invoiceHasActiveCreditNote(supabase, companyId, invoice.id)) {
    return { code: 'INVOICE_PAID_NOT_PAYABLE', details: { reason: 'active_credit_note' } }
  }
  return null
}
