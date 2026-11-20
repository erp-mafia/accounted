/**
 * Konsumentkreditlag (2026:1011): an invoice a consumer pays afterwards is a
 * credit (betalningsanstånd, 1 kap. 3 §). It stays outside the act's credit
 * assessment, pre-contract information and right of withdrawal only while it
 * is a "särskild fakturakredit" (1 kap. 3 §; exemptions in 2 kap. 9 §,
 * 3 kap. 19 §, 4 kap. 21 §, 5 kap. 7 §, 6 kap. 13 §):
 *
 *  - the seller gives the credit itself,
 *  - it carries no kreditkostnad (no interest, no fee for paying by invoice),
 *  - it is due within 50 days of the day the goods or service were delivered.
 *
 * Dröjsmålsränta and the statutory påminnelseavgift (lag 1981:739) are costs
 * of being late, not of the credit, and do not break the exemption
 * (prop. 2025/26:223, kommentaren till 1 kap. 3 §).
 *
 * A seller that is not a "mindre företag" (250 employees or more, turnover
 * above EUR 50 million) selling online has 14 days instead. That seller is
 * not who writes invoices here, so the 50-day rule is the one enforced.
 *
 * The act applies to credit agreements entered into from 2026-11-20
 * (övergångsbestämmelserna p. 1 and 3); the invoice date stands in for that
 * day. Outside the exemption the seller would need a credit assessment per
 * invoice, which nothing here supports, so the doors refuse instead.
 */
import { addDaysIso } from '@/lib/dates/iso'
import type { CustomerType, InvoiceDocumentType } from '@/types'

export const CONSUMER_CREDIT_ACT_FROM = '2026-11-20'
export const CONSUMER_INVOICE_MAX_DAYS = 50

/** Whether an invoice to this customer on this date is a consumer credit. */
export function consumerCreditApplies(
  customerType: CustomerType | null | undefined,
  invoiceDate: string,
): boolean {
  return customerType === 'individual' && invoiceDate >= CONSUMER_CREDIT_ACT_FROM
}

/**
 * Payment terms for a door that derives the due date itself (recurring run,
 * webshop order, order or quote turned into an invoice): the terms asked for,
 * held at 50 days for a consumer.
 */
export function consumerInvoiceTerms(
  terms: number,
  customerType: CustomerType | null | undefined,
  invoiceDate: string,
): number {
  return consumerCreditApplies(customerType, invoiceDate) ? Math.min(terms, CONSUMER_INVOICE_MAX_DAYS) : terms
}

// A charge for being invoiced, by its usual names. A påminnelseavgift is a
// cost of being late, not of the credit: a line that names a reminder or a
// delay is never read as an invoice fee.
const INVOICE_FEE_TEXT = /(faktura|fakturerings|avi|aviserings)avgift|invoic(e|ing) fee|billing fee/i
const LATE_PAYMENT_TEXT = /påminnelse|dröjsmål|försen|inkasso|reminder|late (fee|payment)|overdue/i

/** A line that charges the customer for paying by invoice. */
export function isInvoiceFeeLine(line: { description?: string | null; line_type?: string | null }): boolean {
  if (line.line_type === 'text') return false
  const text = line.description ?? ''
  return INVOICE_FEE_TEXT.test(text) && !LATE_PAYMENT_TEXT.test(text)
}

export type ConsumerCreditRefusal =
  | {
      code: 'INVOICE_CONSUMER_CREDIT_TERMS_TOO_LONG'
      details: { maxDays: number; countedFrom: string; latestDueDate: string; dueDate: string }
    }
  | { code: 'INVOICE_CONSUMER_CREDIT_FEE'; details: { lines: string[] } }

/**
 * Why an invoice to a consumer would fall outside the särskild fakturakredit
 * exemption, or null when it stays inside (or the act does not reach it).
 * Offers, proformas and delivery notes ask for no payment; a credit note is
 * no credit.
 */
export function consumerCreditRefusal(invoice: {
  customerType: CustomerType | null | undefined
  documentType: InvoiceDocumentType
  invoiceDate: string
  dueDate: string
  deliveryDate?: string | null
  total: number
  items: Array<{ description?: string | null; line_type?: string | null }>
}): ConsumerCreditRefusal | null {
  if (invoice.documentType !== 'invoice' || invoice.total <= 0) return null
  if (!consumerCreditApplies(invoice.customerType, invoice.invoiceDate)) return null

  const feeLines = invoice.items.filter(isInvoiceFeeLine).map((line) => line.description ?? '')
  if (feeLines.length > 0) return { code: 'INVOICE_CONSUMER_CREDIT_FEE', details: { lines: feeLines } }

  // Delivery after the invoice date (an advance invoice) moves the count
  // forward. Delivery before it does not move it back: the terms are agreed
  // on the invoice, and a late invoice would otherwise have no lawful due date.
  const countedFrom =
    invoice.deliveryDate && invoice.deliveryDate > invoice.invoiceDate ? invoice.deliveryDate : invoice.invoiceDate
  const latestDueDate = addDaysIso(countedFrom, CONSUMER_INVOICE_MAX_DAYS)
  if (invoice.dueDate > latestDueDate) {
    return {
      code: 'INVOICE_CONSUMER_CREDIT_TERMS_TOO_LONG',
      details: { maxDays: CONSUMER_INVOICE_MAX_DAYS, countedFrom, latestDueDate, dueDate: invoice.dueDate },
    }
  }
  return null
}
