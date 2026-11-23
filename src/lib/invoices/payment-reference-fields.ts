/**
 * The payment reference of a customer invoice as a field of every read
 * outside the app (crm#1886): the v1 invoice responses, the MCP invoice
 * reads and the `invoice.sent` event.
 *
 * The invoice PDF prints the reference the customer pays under, but no door
 * returned it, so an integrator who delivers the invoice in a PDF or mail of
 * their own had to rebuild it (strip the non-digits, add a Luhn check digit,
 * and a length digit when the company prints one)
 * or read it off the PDF. These two fields are the document's own answer:
 *
 *   payment_reference       what the payer writes with the payment
 *   payment_reference_type  'ocr' or 'invoice_number' (InvoicePaymentReferenceType)
 *
 * Both are null on a document that asks nobody to pay under a reference: one
 * without a number yet (a draft), a credit note, a quote, a proforma, a
 * delivery note, and an invoice Bankgirot debits by Autogiro.
 *
 * Nothing is derived here. Which reference an invoice carries is
 * invoicePaymentReference (ocr-reference.ts), the function the PDF payment
 * box, the mails and the bank-app QR read, with the same inputs the PDF
 * render gives it: the company with the invoice's payee applied
 * (companyWithInvoicePaymentAccount) and the customer's language. So the
 * field follows the company's settings as the PDF does: an invoice whose
 * company adds a bankgiro later prints, and reports, the OCR from then on.
 * The bank match reads a payment under either form (ocr-keys.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  companyWithInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/cash-accounts/invoice-payment-accounts'
import { invoicePaymentReference, type InvoicePaymentReferenceType } from '@/lib/invoices/ocr-reference'
import { invoiceAutogiroPayerNumber } from '@/lib/invoices/payment-rows'
import { chunk } from '@/lib/utils'
import type { CompanySettings, Currency, InvoiceDocumentType, InvoicePaymentAccount } from '@/types'

/** The columns a door already holds: enough to say whether the document carries a reference at all. */
export interface PaymentReferenceRow {
  id: string
  invoice_number?: string | null
  document_type?: string | null
  credited_invoice_id?: string | null
  total?: number | string | null
  currency?: string | null
}

export interface InvoicePaymentReferenceFields {
  payment_reference: string | null
  payment_reference_type: InvoicePaymentReferenceType | null
}

/** What the reference also depends on, read per invoice by withPaymentReference. */
export interface PaymentReferenceFacts {
  /** The invoice's own frozen payee (invoices.payment_details); null = the company's default. */
  payment_details?: Partial<InvoicePaymentAccount> | null
  /** Set when Bankgirot debits the invoice: the customer is then asked for nothing. */
  autogiro_payer_number?: string | null
  /** customers.language: the language the PDF is printed in. */
  language?: string | null
}

/**
 * The two fields in words, for the endpoint documentation of every door that
 * returns them (the OpenAPI spec and the generated API skill read it).
 */
export const PAYMENT_REFERENCE_PITFALL =
  'payment_reference is the reference the invoice asks the payer to quote, the one its PDF prints; payment_reference_type says how it is built. ' +
  'ocr: the digits of invoice_number followed by a Luhn (10-modulen) check digit, 2 to 25 digits (invoice 2026-0042 gives 202600425). When the company setting invoice_ocr_length_digit is true, Bankgirot\'s length digit stands before the check digit (202600425 becomes 2026004206), for a bankgiro whose OCR control also checks the length; without it the reference fits a control of the check digit alone. ' +
  'invoice_number: the invoice number as it is, written as the message of the payment. ' +
  'An invoice carries ocr when it is printed in Swedish with a bankgiro or plusgiro and the company has not turned the OCR reference off, otherwise invoice_number; the value follows those settings, as the PDF does. ' +
  'Both are null when the document asks for no payment under a reference: no number yet (a draft), a credit note, a quote, a proforma, a delivery note, an invoice debited by Autogiro. ' +
  'An incoming payment is matched under either form.'

const NO_PAYMENT_REFERENCE: InvoicePaymentReferenceFields = {
  payment_reference: null,
  payment_reference_type: null,
}

/** Ids per read of the invoices' reference facts. */
const FACTS_READ_CHUNK = 200

/**
 * Whether the row is a numbered document that asks the customer for a
 * payment: the PDF's own rule for which documents need a payee
 * (invoiceRequiresPaymentAccount), and a number to build the reference from.
 */
function asksForPayment(row: PaymentReferenceRow): boolean {
  if (!row.invoice_number?.trim()) return false
  return invoiceRequiresPaymentAccount({
    credited_invoice_id: row.credited_invoice_id ?? null,
    document_type: (row.document_type || 'invoice') as InvoiceDocumentType,
    total: Number(row.total) || 0,
  })
}

/**
 * The two fields for one invoice. `company` is the settings row as stored
 * (the payee is applied here, as the PDF render does); null when the company
 * has none, which prints no giro and so no OCR.
 */
export function invoicePaymentReferenceFields(
  row: PaymentReferenceRow,
  facts: PaymentReferenceFacts,
  company: CompanySettings | null,
): InvoicePaymentReferenceFields {
  if (!asksForPayment(row)) return NO_PAYMENT_REFERENCE
  if (invoiceAutogiroPayerNumber(facts)) return NO_PAYMENT_REFERENCE
  const printed: Parameters<typeof invoicePaymentReference>[0] = company
    ? companyWithInvoicePaymentAccount(company, (row.currency || 'SEK') as Currency, facts.payment_details ?? null)
    : {}
  // The PDF's language rule (render-invoice-pdf.ts): the customer's, Swedish by default.
  const lang = facts.language === 'en' ? 'en' : 'sv'
  const { reference, type } = invoicePaymentReference(printed, row.invoice_number, lang)
  return reference ? { payment_reference: reference, payment_reference_type: type } : NO_PAYMENT_REFERENCE
}

type FactsRow = {
  id: string
  payment_details: Partial<InvoicePaymentAccount> | null
  autogiro_payer_number: string | null
  customer: { language: string | null } | { language: string | null }[] | null
}

/**
 * `rows` with the two fields added: the one projection every door reads them
 * through, so the v1 responses, the MCP reads and the event cannot disagree.
 * Reads the company's settings and the rows' own facts only when a row can
 * carry a reference (a list of drafts costs nothing). A failed read throws:
 * a reference is never reported from guessed settings. A door that already
 * holds the settings row (one that just rendered the PDF from it) passes it
 * as `known.company` and saves that read.
 */
export async function withPaymentReference<T extends PaymentReferenceRow>(
  supabase: SupabaseClient,
  companyId: string,
  rows: T[],
  known?: { company: CompanySettings | null },
): Promise<Array<T & InvoicePaymentReferenceFields>> {
  const ids = rows.filter(asksForPayment).map((row) => row.id)
  if (ids.length === 0) return rows.map((row) => ({ ...row, ...NO_PAYMENT_REFERENCE }))

  let company: CompanySettings | null
  if (known) {
    company = known.company
  } else {
    const { data, error } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(`company_settings read failed: ${error.message}`)
    company = (data as CompanySettings | null) ?? null
  }

  const factsById = new Map<string, PaymentReferenceFacts>()
  for (const idChunk of chunk(ids, FACTS_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, payment_details, autogiro_payer_number, customer:customers(language)')
      .eq('company_id', companyId)
      .in('id', idChunk)
    if (error) throw new Error(`invoice payment reference read failed: ${error.message}`)
    for (const fact of (data ?? []) as unknown as FactsRow[]) {
      const customer = Array.isArray(fact.customer) ? (fact.customer[0] ?? null) : fact.customer
      factsById.set(fact.id, {
        payment_details: fact.payment_details,
        autogiro_payer_number: fact.autogiro_payer_number,
        language: customer?.language ?? null,
      })
    }
  }

  return rows.map((row) => {
    const facts = factsById.get(row.id)
    // A row the facts read did not return (deleted in between) reports no
    // reference: its payee and its Autogiro state are unknown.
    return {
      ...row,
      ...(facts ? invoicePaymentReferenceFields(row, facts, company) : NO_PAYMENT_REFERENCE),
    }
  })
}
