/**
 * One reading of a document: one canonical set of fields, each with where it
 * came from and how far it can be trusted.
 *
 * Today the fields of an underlag live in three places with two schemas:
 * document_attachments.extracted_data (with the model's own reading kept in
 * model_reading once a person corrects it), invoice_inbox_items.extracted_data
 * and, for a received e-invoice, the parsed Peppol UBL. This module is the
 * read side only: it stores nothing and resolves what is already stored into
 * one DocumentReading (./resolve.ts, loaded by ./load.ts).
 *
 * The field set is the field rule of 2026-09-27: a structured field only for
 * what a machine acts on. Everything else on the document stays raw text that
 * an agent reads at question time (gnubok_ask_document). Field names are the
 * EN 16931 business terms (READING_TERMS below names each one), checked
 * against the Peppol BIS Billing 3.0 syntax pages.
 *
 * Pure types and constants: no client, no I/O.
 */
import type { InboxDocumentKind } from '@/lib/documents/inbox-kind'
import type { IntakeSourceId } from '@/lib/intake/sources'

/**
 * Where a field's value came from:
 *   - xml: a structured door, the parsed Peppol UBL (the sender's own data);
 *   - vision: a model that was handed the file itself (a photo, a PDF);
 *   - text: a model that was handed text only (a mail body);
 *   - door: what the door recorded or declared with the item, not read off
 *     the document (the Peppol sender endpoint, the +lev / +ver kind);
 *   - person: a person's correction of the reading.
 */
export const READING_SOURCES = ['xml', 'text', 'vision', 'door', 'person'] as const
export type ReadingSource = (typeof READING_SOURCES)[number]

/**
 * The evidence level a person is shown (Exakt, Stark, Trolig, Ditt val),
 * never the model's own confidence number:
 *   - exakt: a structured source (xml);
 *   - stark: a machine reading another source agrees with (corroborated_by);
 *   - trolig: a machine reading nothing corroborates;
 *   - ditt_val: a person chose it.
 */
export const EVIDENCE_LEVELS = ['exakt', 'stark', 'trolig', 'ditt_val'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

/**
 * What made a machine reading Stark:
 *   - second_reading: the document's Arkiv record, an independent extraction, read the same value;
 *   - supplier_register: the matched supplier's card holds the same value;
 *   - vat_identifier: a Swedish VAT number (SE + organisationsnummer + 01) and the organisationsnummer agree;
 *   - vat_breakdown: the VAT breakdown adds up to the amount due;
 *   - declared_kind: the kind declared with the item and the model's kind agree.
 */
export const CORROBORATIONS = ['second_reading', 'supplier_register', 'vat_identifier', 'vat_breakdown', 'declared_kind'] as const
export type Corroboration = (typeof CORROBORATIONS)[number]

export interface ReadingField<T> {
  /** Null only when a person cleared a value a reading had. */
  value: T | null
  source: ReadingSource
  evidence: EvidenceLevel
  /** 1-based page the value stands on, when a reading located it. */
  page?: number
  /** The text the value was read from, verbatim, when a reading quoted it. */
  quote?: string
  /** Present on a Stark field: what agrees with it. */
  corroborated_by?: Corroboration[]
}

/** One row of the VAT breakdown (BG-23). */
export interface ReadingVatBreakdownEntry {
  /** BT-119 VAT category rate, in percent. */
  vat_category_rate: number
  /** BT-116 VAT category taxable amount. */
  vat_category_taxable_amount: number
  /** BT-117 VAT category tax amount. */
  vat_category_tax_amount: number
  /** BT-118 VAT category code (UNCL5305: S, Z, E, AE, K, G, O), structured doors only. */
  vat_category_code?: string
}

/** One invoice line (BG-25), structured doors only. */
export interface ReadingInvoiceLine {
  /** BT-126 Invoice line identifier. */
  invoice_line_identifier: string | null
  /** BT-153 Item name. */
  item_name: string
  /** BT-129 Invoiced quantity. */
  invoiced_quantity: number
  /** BT-146 Item net price. */
  item_net_price: number | null
  /** BT-131 Invoice line net amount. */
  invoice_line_net_amount: number
  /** BT-151 Invoiced item VAT category code. */
  invoiced_item_vat_category_code: string | null
  /** BT-152 Invoiced item VAT rate, in percent. */
  invoiced_item_vat_rate: number | null
}

/**
 * The value type of every field. Amounts are signed the way the inbox books
 * them: a credit note's amounts are below zero, where a UBL CreditNote prints
 * them positive and says CreditNote instead.
 */
export interface ReadingValues {
  seller_name: string
  seller_legal_registration_identifier: string
  seller_vat_identifier: string
  seller_country_code: string
  document_type: InboxDocumentKind
  invoice_type_code: string
  invoice_number: string
  invoice_issue_date: string
  payment_due_date: string
  invoice_currency_code: string
  amount_due_for_payment: number
  vat_breakdown: ReadingVatBreakdownEntry[]
  remittance_information: string
  payment_account_bankgiro: string
  payment_account_plusgiro: string
  payment_account_iban: string
  payment_service_provider_identifier: string
  preceding_invoice_reference: string
  invoice_lines: ReadingInvoiceLine[]
}

export type ReadingFieldName = keyof ReadingValues

export type ReadingFields = { [K in ReadingFieldName]?: ReadingField<ReadingValues[K]> }

/**
 * The EN 16931 business term behind each field. `document_type` is the one
 * field EN 16931 has no term for: it carries the role of BT-3 across the
 * documents EN 16931 does not cover (a receipt), in the inbox's own kinds;
 * `invoice_type_code` is BT-3 itself, from a structured door.
 */
export const READING_TERMS: Readonly<Record<ReadingFieldName, { term: string; name: string }>> = {
  seller_name: { term: 'BT-27', name: 'Seller name' },
  seller_legal_registration_identifier: { term: 'BT-30', name: 'Seller legal registration identifier' },
  seller_vat_identifier: { term: 'BT-31', name: 'Seller VAT identifier' },
  seller_country_code: { term: 'BT-40', name: 'Seller country code' },
  document_type: { term: 'BT-3', name: 'Invoice type code, widened to the inbox kinds' },
  invoice_type_code: { term: 'BT-3', name: 'Invoice type code' },
  invoice_number: { term: 'BT-1', name: 'Invoice number' },
  invoice_issue_date: { term: 'BT-2', name: 'Invoice issue date' },
  payment_due_date: { term: 'BT-9', name: 'Payment due date' },
  invoice_currency_code: { term: 'BT-5', name: 'Invoice currency code' },
  amount_due_for_payment: { term: 'BT-115', name: 'Amount due for payment' },
  vat_breakdown: { term: 'BG-23', name: 'VAT breakdown' },
  remittance_information: { term: 'BT-83', name: 'Remittance information' },
  payment_account_bankgiro: { term: 'BT-84', name: 'Payment account identifier (BT-86 SE:BANKGIRO)' },
  payment_account_plusgiro: { term: 'BT-84', name: 'Payment account identifier (BT-86 SE:PLUSGIRO)' },
  payment_account_iban: { term: 'BT-84', name: 'Payment account identifier (IBAN)' },
  payment_service_provider_identifier: { term: 'BT-86', name: 'Payment service provider identifier (the BIC)' },
  preceding_invoice_reference: { term: 'BT-25', name: 'Preceding Invoice reference' },
  invoice_lines: { term: 'BG-25', name: 'Invoice line' },
}

export const READING_FIELD_NAMES = Object.keys(READING_TERMS) as ReadingFieldName[]

/**
 * What a reader should know about the reading as a whole:
 *   - origin_unknown: the document keeps no model reading to compare with,
 *     so a person's edit cannot be told from the model's value; every value
 *     is attributed to the model;
 *   - agent_reading: an agent supplied the reading
 *     (gnubok_set_inbox_extracted_data); it is attributed as a machine
 *     reading, never as a person's choice;
 *   - structured_source_missing: a Peppol item whose UBL could not be found;
 *     its values are attributed as an unverified reading.
 */
export const READING_NOTES = ['origin_unknown', 'agent_reading', 'structured_source_missing'] as const
export type ReadingNote = (typeof READING_NOTES)[number]

/** How the document arrived: what the door recorded, never a reading of the document. */
export interface ReadingDoor {
  intake_source: IntakeSourceId | null
  /** The Peppol sender endpoint, the mailbox sender or the e-mail sender. */
  sender: string | null
  received_at: string | null
}

export interface DocumentReading {
  document_id: string | null
  inbox_item_id: string | null
  /** Only fields some source has a value for (or a person cleared). */
  fields: ReadingFields
  door: ReadingDoor
  notes: ReadingNote[]
}
