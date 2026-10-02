/**
 * What an invoice still asks the customer to pay: ONE definition for the PDF
 * payment box and every payment QR (Swish, payment link, bank app).
 *
 * Each QR builder used to decide on its own. The bank-app QR skipped paid,
 * cancelled and credited invoices and encoded the remainder of a partly paid
 * one; the Swish and payment-link QRs had no status gate and Swish encoded
 * the full "Att betala". So the betalningsbekräftelse (the paid re-render)
 * carried a pay-again Swish QR locked at the full amount. All three now ask
 * this module, so they cannot disagree again.
 *
 * Pure and isomorphic (no fs, no crypto): the invoice editor can import it.
 */
import { roundOre } from '@/lib/money'
import { getAmountToPay } from '@/lib/invoices/rounding'
import type { CompanySettings, Invoice } from '@/types'

/** The invoice header fields that decide whether it is a payment request. */
export interface PayableInvoiceShape {
  status?: string | null
  document_type?: string | null
  credited_invoice_id?: string | null
}

/** Statuses whose document must never ask for a payment. */
const NON_PAYABLE_STATUSES: ReadonlySet<string> = new Set(['paid', 'cancelled', 'credited'])

/**
 * Whether the invoice still asks for a payment: a real faktura (not a credit
 * note, proforma, quote or delivery note) that is not paid, cancelled or
 * credited. Drafts and previews count as payable (they show what the sent
 * invoice will ask for); a partly paid invoice is payable for its remainder.
 */
export function isInvoicePayableStatus(invoice: PayableInvoiceShape): boolean {
  if ((invoice.document_type || 'invoice') !== 'invoice') return false
  if (invoice.credited_invoice_id) return false
  return !(invoice.status && NON_PAYABLE_STATUSES.has(invoice.status))
}

/** The fields invoiceAmountDue reads. */
export type AmountDueInvoice = PayableInvoiceShape &
  Pick<Invoice, 'total' | 'currency'> & {
    ore_rounding?: boolean | null
    deduction_total?: number | null
    paid_amount?: number | null
    remaining_amount?: number | null
  }

/**
 * The remainder of a partly paid invoice. `remaining_amount` is the ledger's
 * own figure (kept by the payment paths and the invoices_derive_remaining_amount
 * guard, net of any ROT/RUT deduction and plus any reclaimed part), so it wins;
 * the "Att betala" minus what was paid is only the fallback for a row without it.
 */
export function partlyPaidRemainder(
  invoice: Pick<AmountDueInvoice, 'paid_amount' | 'remaining_amount'>,
  amountToPay: number,
): number {
  const remainder =
    typeof invoice.remaining_amount === 'number'
      ? invoice.remaining_amount
      : amountToPay - (invoice.paid_amount ?? 0)
  return Math.max(0, roundOre(remainder))
}

/**
 * The amount the invoice asks for right now, the figure every payment QR must
 * encode:
 *   - 0 when the document is not a payment request (isInvoicePayableStatus):
 *     paid, cancelled, credited, a credit note, proforma, quote, delivery note;
 *   - the remainder when it is partly paid (partlyPaidRemainder);
 *   - otherwise "Att betala" (öresavrundning, then the ROT/RUT deduction),
 *     the same figure the PDF totals block and the invoice email print.
 * Never negative; callers treat 0 as "nothing to pay, no QR".
 */
export function invoiceAmountDue(
  invoice: AmountDueInvoice,
  company: Pick<CompanySettings, 'ore_rounding'> | null | undefined,
): number {
  if (!isInvoicePayableStatus(invoice)) return 0
  const { toPay } = getAmountToPay(invoice, company)
  if (invoice.status === 'partially_paid') return partlyPaidRemainder(invoice, toPay)
  return Math.max(0, roundOre(toPay))
}
