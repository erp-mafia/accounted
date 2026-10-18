/**
 * The DocumentReading (./types.ts) as a Zod schema, for the v1 contract and
 * its OpenAPI document. The response is not validated against it: it
 * documents what ./resolve.ts returns.
 */
import { z } from 'zod'
import { INBOX_DOCUMENT_KINDS } from '@/lib/documents/inbox-kind'
import { INTAKE_SOURCE_IDS } from '@/lib/intake/sources'
import { CORROBORATIONS, EVIDENCE_LEVELS, READING_NOTES, READING_SOURCES } from './types'

function field<T extends z.ZodTypeAny>(value: T, description: string) {
  return z
    .object({
      value: value.nullable().describe('Null only when a person cleared a value a reading had.'),
      source: z.enum(READING_SOURCES),
      evidence: z.enum(EVIDENCE_LEVELS),
      page: z.number().int().optional().describe('1-based page, when a reading located the value.'),
      quote: z.string().optional().describe('The text the value was read from, verbatim.'),
      corroborated_by: z.array(z.enum(CORROBORATIONS)).optional().describe('On a stark field: what agrees with it.'),
    })
    .optional()
    .describe(description)
}

const VatBreakdownEntry = z.object({
  vat_category_rate: z.number().describe('BT-119, percent.'),
  vat_category_taxable_amount: z.number().describe('BT-116.'),
  vat_category_tax_amount: z.number().describe('BT-117.'),
  vat_category_code: z.string().optional().describe('BT-118 (S, Z, E, AE, K, G, O): structured doors only.'),
})

const InvoiceLine = z.object({
  invoice_line_identifier: z.string().nullable().describe('BT-126.'),
  item_name: z.string().describe('BT-153.'),
  invoiced_quantity: z.number().describe('BT-129.'),
  item_net_price: z.number().nullable().describe('BT-146.'),
  invoice_line_net_amount: z.number().describe('BT-131.'),
  invoiced_item_vat_category_code: z.string().nullable().describe('BT-151.'),
  invoiced_item_vat_rate: z.number().nullable().describe('BT-152, percent.'),
})

export const DocumentReadingSchema = z
  .object({
    document_id: z.string().uuid().nullable(),
    inbox_item_id: z.string().uuid().nullable(),
    fields: z
      .object({
        seller_name: field(z.string(), 'BT-27 Seller name.'),
        seller_legal_registration_identifier: field(z.string(), 'BT-30: the organisationsnummer.'),
        seller_vat_identifier: field(z.string(), 'BT-31.'),
        seller_country_code: field(z.string(), 'BT-40, ISO 3166; from a model reading derived from the VAT identifier.'),
        document_type: field(z.enum(INBOX_DOCUMENT_KINDS), "BT-3's role in the inbox kinds, decided by the inbox's kind rule."),
        invoice_type_code: field(z.string(), 'BT-3 (380, 381, ...): structured doors only.'),
        invoice_number: field(z.string(), 'BT-1.'),
        invoice_issue_date: field(z.string(), 'BT-2, YYYY-MM-DD.'),
        payment_due_date: field(z.string(), 'BT-9, YYYY-MM-DD.'),
        invoice_currency_code: field(z.string(), 'BT-5, ISO 4217.'),
        amount_due_for_payment: field(z.number(), 'BT-115: the total to pay (a receipt: paid). Below zero on a credit note.'),
        vat_breakdown: field(z.array(VatBreakdownEntry), 'BG-23, one row per rate.'),
        remittance_information: field(z.string(), 'BT-83: the OCR or payment reference.'),
        payment_account_bankgiro: field(z.string(), 'BT-84 under BT-86 SE:BANKGIRO.'),
        payment_account_plusgiro: field(z.string(), 'BT-84 under BT-86 SE:PLUSGIRO.'),
        payment_account_iban: field(z.string(), 'BT-84 as an IBAN.'),
        payment_service_provider_identifier: field(z.string(), 'BT-86: the BIC beside the IBAN.'),
        preceding_invoice_reference: field(z.string(), 'BT-25: on a credit note, the invoice it credits.'),
        invoice_lines: field(z.array(InvoiceLine), 'BG-25: structured doors only.'),
      })
      .describe('Only fields some source has a value for. Field names are EN 16931 business terms.'),
    door: z
      .object({
        intake_source: z.enum(INTAKE_SOURCE_IDS).nullable(),
        sender: z.string().nullable().describe('The Peppol sender endpoint, the mailbox sender or the e-mail sender.'),
        received_at: z.string().nullable(),
      })
      .describe('How it arrived, as the door recorded it: never a reading of the document.'),
    notes: z.array(z.enum(READING_NOTES)),
  })
  .describe(
    'One reading of the document. Precedence per field: person > xml > model > door. evidence: exakt (structured source), stark (machine reading something agrees with), trolig (machine reading alone), ditt_val (a person chose it).',
  )
