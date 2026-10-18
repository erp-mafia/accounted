import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { Invoice } from '@/types'

/**
 * The business events of a customer invoice's verifikat, for the posting
 * port (step 2f): its registration (sale.invoiced), booked when it is issued,
 * by the deferred Bokför step or when a received självfaktura is registered,
 * and its kreditfaktura (sale.credited). Pure: built only while
 * POSTING_EVENTS is shadow or strict, never while it is off.
 *
 * The subject is the invoices row the verifikat books (a kreditfaktura is a
 * row of its own, which names the original in credited_invoice_id), the
 * party its customer by type and id. Amounts are magnitudes (a kreditfaktura
 * stores them negated): the total in the invoice's currency, the total in
 * SEK, and the utgående moms the invoice states in SEK under its
 * vat_treatment. Under omvänd betalningsskyldighet and export the invoice
 * states none. The SEK figures are converted as the booking converts them
 * (resolveSekAmountOrNull): a SEK invoice is its own SEK figure (a received
 * självfaktura stores no *_sek twins), a foreign one takes its *_sek twin,
 * else the amount at the invoice's rate, and without either has none rather
 * than a guess. The total includes a ROT/RUT share: the sale is the whole
 * price, and who pays which part (1510 and 1513) stays in the lines. No
 * category: an invoice row carries neither a category nor a booking
 * template, and an account is never read as a category.
 */

/** What a door saw when it posted an invoice's verifikat. */
export interface InvoicePostingContext {
  /** The door's link basis, resolved in its request (linkBasisColumns). */
  linkBasis?: LinkBasisColumns
}

type EventInvoice = Pick<
  Invoice,
  | 'id'
  | 'customer_id'
  | 'invoice_date'
  | 'currency'
  | 'exchange_rate'
  | 'total'
  | 'total_sek'
  | 'vat_amount'
  | 'vat_amount_sek'
  | 'vat_treatment'
>

/** The SEK magnitude of an invoice amount, converted as the booking converts it, or null. */
function sekMagnitude(invoice: EventInvoice, amount: number, sek: number | null | undefined): number | null {
  return resolveSekAmountOrNull(Math.abs(amount), sek == null ? null : Math.abs(sek), invoice.currency, invoice.exchange_rate)
}

function invoiceEvent(
  invoice: EventInvoice,
  context: InvoicePostingContext,
  linesFromRules: boolean,
): Omit<BusinessEventDraft, 'kind' | 'idempotencyKey'> {
  const vatSek = sekMagnitude(invoice, invoice.vat_amount ?? 0, invoice.vat_amount_sek) ?? 0
  const linkEvidence = context.linkBasis?.link_evidence ?? null
  return {
    category: null,
    occurredOn: invoice.invoice_date,
    subject: { type: 'invoice', id: invoice.id },
    party: { type: 'customer', id: invoice.customer_id },
    currency: invoice.currency,
    amount: Math.abs(invoice.total),
    amountSek: sekMagnitude(invoice, invoice.total, invoice.total_sek),
    taxAmounts: vatSek > 0 ? [{ tax: 'vat', treatment: invoice.vat_treatment ?? null, amount_sek: vatSek }] : [],
    evidence: {
      link_basis: context.linkBasis?.link_basis ?? undefined,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
    // User-edited lines (the send dialog's) were written by a person, not by
    // a rule: they name no rule version.
    mappingVersion: linesFromRules ? mappingVersion('customerInvoice') : null,
    jurisdiction: 'SE',
  }
}

/**
 * The registration verifikat's event (sale.invoiced), dated the invoice
 * date: under faktureringsmetoden the sale is booked at fakturadatum. One
 * event per invoice: the idempotency key ties a retried issue or Bokför step
 * to the event its first attempt recorded.
 */
export function invoiceRegistrationBusinessEvent(
  invoice: EventInvoice,
  context: InvoicePostingContext = {},
  options: { userEditedLines?: boolean } = {},
): BusinessEventDraft {
  return {
    ...invoiceEvent(invoice, context, !options.userEditedLines),
    kind: 'sale.invoiced',
    idempotencyKey: `sale.invoiced:invoice:${invoice.id}`,
  }
}

/**
 * The kreditfaktura verifikat's event (sale.credited), dated the credit
 * note's own date: the seller reduces utgående moms in the period of the
 * kreditfaktura (ML 17 kap 22-23 §). The subject is the credit note row. One
 * event per credit note: issuing it is idempotent and a refused issue is
 * retried on the same row, which links to the event the first attempt
 * recorded.
 */
export function creditNoteBusinessEvent(creditNote: EventInvoice, context: InvoicePostingContext = {}): BusinessEventDraft {
  return {
    ...invoiceEvent(creditNote, context, true),
    kind: 'sale.credited',
    idempotencyKey: `sale.credited:invoice:${creditNote.id}`,
  }
}
