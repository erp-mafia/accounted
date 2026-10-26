/**
 * The assemblers of one reading: each turns one stored source into canonical
 * values (ReadingValues), and the checks that say when a machine value is
 * corroborated. ./resolve.ts decides between them.
 *
 *   - projectExtraction: the inbox extraction shape (InvoiceExtractionResult),
 *     which the model writes, a person corrects and the Peppol delivery fills;
 *   - xmlValues: the parsed Peppol UBL, through the same mapping the delivery
 *     used to fill the inbox item (peppolDocumentToExtraction), plus what only
 *     the UBL carries (BT-3, BT-40, the VAT category codes, the line ids);
 *   - arkivAgreement: the document's Arkiv record (document_extractions), an
 *     independent extraction with a page and a verbatim quote per field.
 *
 * Pure: no client, no I/O.
 */
import type { InvoiceExtractionResult } from '@/types'
import { isInboxDocumentKind } from '@/lib/documents/inbox-kind'
import { normalizeDate, normalizeOrgNumber } from '@/lib/documents/extract/fields'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import { isMalformedEuVatNumber } from '@/lib/invariants/vat-number'
import type { PeppolInboundDocument } from '@/lib/invoices/peppol-inbound-ubl'
import type {
  Corroboration,
  ReadingFieldName,
  ReadingInvoiceLine,
  ReadingValues,
  ReadingVatBreakdownEntry,
} from './types'

/** Canonical values one source holds; a field it has no value for is absent. */
export type ReadingValueMap = { [K in ReadingFieldName]?: ReadingValues[K] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function put<K extends ReadingFieldName>(out: ReadingValueMap, field: K, value: ReadingValues[K] | undefined): void {
  if (value !== undefined) out[field] = value
}

/** Letters and digits only, upper case: how identifiers compare ('556677-8899' is '5566778899'). */
const alnum = (value: unknown): string => String(value).toUpperCase().replace(/[^0-9A-Z]/g, '')

/** Letters and digits only, any case: how names compare. */
const letters = (value: unknown): string => String(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

const collapse = (value: unknown): string => String(value).replace(/\s+/g, ' ').trim()

/**
 * The country a VAT identifier names: an EU VAT number starts with the
 * member state's code, which is the ISO 3166 code except Greece's EL and
 * Northern Ireland's XI.
 */
export function countryFromVatIdentifier(vat: string | undefined): string | undefined {
  if (isMalformedEuVatNumber(vat)) return undefined
  const match = vat?.replace(/\s/g, '').toUpperCase().match(/^([A-Z]{2})[0-9A-Z]{2,}$/)
  if (!match) return undefined
  if (match[1] === 'EL') return 'GR'
  if (match[1] === 'XI') return 'GB'
  return match[1]
}

function vatBreakdownOf(raw: unknown): ReadingVatBreakdownEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const row = recordOf(entry)
    const rate = num(row.rate)
    const base = num(row.base)
    const amount = num(row.amount)
    if (rate === undefined || base === undefined || amount === undefined) return []
    return [{ vat_category_rate: rate, vat_category_taxable_amount: base, vat_category_tax_amount: amount }]
  })
}

function linesOf(raw: unknown): ReadingInvoiceLine[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const line = recordOf(entry)
    const net = num(line.lineTotal)
    if (net === undefined) return []
    return [
      {
        invoice_line_identifier: null,
        item_name: str(line.description) ?? '',
        invoiced_quantity: num(line.quantity) ?? 1,
        item_net_price: num(line.unitPrice) ?? null,
        invoice_line_net_amount: net,
        invoiced_item_vat_category_code: null,
        invoiced_item_vat_rate: num(line.vatRate) ?? null,
      },
    ]
  })
}

/**
 * The canonical values of an inbox extraction (InvoiceExtractionResult, as
 * stored: older readings lack the optional fields). The seller country is
 * derived from the VAT identifier, since the extraction reads no country.
 */
export function projectExtraction(raw: unknown): ReadingValueMap {
  if (!isRecord(raw)) return {}
  const supplier = recordOf(raw.supplier)
  const invoice = recordOf(raw.invoice)
  const totals = recordOf(raw.totals)
  const out: ReadingValueMap = {}
  // A value with an EU prefix that is not that state's VAT number (a VAT-code label such as "SESL000D") is
  // neither the seller's VAT number nor its country (crm#1411).
  const readVat = str(supplier.vatNumber)
  const vat = readVat && !isMalformedEuVatNumber(readVat) ? readVat : undefined
  put(out, 'seller_name', str(supplier.name))
  put(out, 'seller_legal_registration_identifier', str(supplier.orgNumber))
  put(out, 'seller_vat_identifier', vat)
  put(out, 'seller_country_code', countryFromVatIdentifier(vat))
  if (isInboxDocumentKind(raw.documentKind)) out.document_type = raw.documentKind
  put(out, 'invoice_number', str(invoice.invoiceNumber))
  put(out, 'invoice_issue_date', str(invoice.invoiceDate))
  put(out, 'payment_due_date', str(invoice.dueDate))
  put(out, 'invoice_currency_code', str(invoice.currency)?.toUpperCase())
  put(out, 'amount_due_for_payment', num(totals.total))
  const breakdown = vatBreakdownOf(raw.vatBreakdown)
  if (breakdown.length > 0) out.vat_breakdown = breakdown
  put(out, 'remittance_information', str(invoice.paymentReference))
  put(out, 'payment_account_bankgiro', str(supplier.bankgiro))
  put(out, 'payment_account_plusgiro', str(supplier.plusgiro))
  put(out, 'payment_account_iban', str(supplier.iban))
  put(out, 'payment_service_provider_identifier', str(supplier.bic))
  put(out, 'preceding_invoice_reference', str(invoice.creditedInvoiceNumber))
  const lines = linesOf(raw.lineItems)
  if (lines.length > 0) out.invoice_lines = lines
  return out
}

/** Where each field sits in the inbox extraction shape. */
const EXTRACTION_PATHS: Record<ReadingFieldName, readonly [string] | readonly [string, string]> = {
  seller_name: ['supplier', 'name'],
  seller_legal_registration_identifier: ['supplier', 'orgNumber'],
  seller_vat_identifier: ['supplier', 'vatNumber'],
  seller_country_code: ['supplier', 'vatNumber'],
  document_type: ['documentKind'],
  invoice_type_code: ['documentKind'],
  invoice_number: ['invoice', 'invoiceNumber'],
  invoice_issue_date: ['invoice', 'invoiceDate'],
  payment_due_date: ['invoice', 'dueDate'],
  invoice_currency_code: ['invoice', 'currency'],
  amount_due_for_payment: ['totals', 'total'],
  vat_breakdown: ['vatBreakdown'],
  remittance_information: ['invoice', 'paymentReference'],
  payment_account_bankgiro: ['supplier', 'bankgiro'],
  payment_account_plusgiro: ['supplier', 'plusgiro'],
  payment_account_iban: ['supplier', 'iban'],
  payment_service_provider_identifier: ['supplier', 'bic'],
  preceding_invoice_reference: ['invoice', 'creditedInvoiceNumber'],
  invoice_lines: ['lineItems'],
}

/** Fields read off another field's path rather than stored at their own. */
const DERIVED_FIELDS: ReadonlySet<ReadingFieldName> = new Set(['seller_country_code', 'invoice_type_code'])

/**
 * The fields stored at the given extraction paths ('supplier.name'), the
 * derived ones (the country from the VAT number, BT-3 beside the kind) left
 * out: what a person's marked correction (personFields) covers.
 */
export function fieldsAtPaths(paths: readonly string[]): Set<ReadingFieldName> {
  const wanted = new Set(paths)
  const out = new Set<ReadingFieldName>()
  for (const [field, path] of Object.entries(EXTRACTION_PATHS) as Array<[ReadingFieldName, readonly string[]]>) {
    if (!DERIVED_FIELDS.has(field) && wanted.has(path.join('.'))) out.add(field)
  }
  return out
}

/**
 * Whether the stored extraction holds the field's key at all, a null
 * included. A person's correction always writes the key (a cleared field is
 * an explicit null); a key that is missing was never written, because the
 * reading predates the field (iban, bic and creditedInvoiceNumber arrived
 * later), and is no correction.
 */
export function holdsKey(raw: unknown, field: ReadingFieldName): boolean {
  if (!isRecord(raw)) return false
  const path = EXTRACTION_PATHS[field]
  if (path.length === 1) return path[0] in raw
  const parent = raw[path[0]]
  return isRecord(parent) && path[1] in parent
}

/** Same filter as peppolDocumentToExtraction's VAT breakdown, so the codes line up with its rows. */
const mappedSubtotal = (s: PeppolInboundDocument['taxSubtotals'][number]) =>
  s.percent !== null && s.taxableAmount !== null && s.taxAmount !== null

/**
 * The canonical values of a parsed Peppol document, and the extraction the
 * delivery made of it (what the inbox item held before any correction).
 */
export function xmlValues(
  document: PeppolInboundDocument,
  toExtraction: (document: PeppolInboundDocument) => InvoiceExtractionResult,
): { values: ReadingValueMap; extraction: InvoiceExtractionResult } {
  const extraction = toExtraction(document)
  const values = projectExtraction(extraction)
  put(values, 'invoice_type_code', str(document.typeCode))
  const country = str(document.supplier.countryCode)?.toUpperCase()
  if (country) values.seller_country_code = country
  const subtotals = document.taxSubtotals.filter(mappedSubtotal)
  if (values.vat_breakdown) {
    values.vat_breakdown = values.vat_breakdown.map((entry, i) => {
      const code = str(subtotals[i]?.categoryId)
      return code ? { ...entry, vat_category_code: code } : entry
    })
  }
  if (values.invoice_lines) {
    // peppolDocumentToExtraction maps every line in order, so index i is UBL line i.
    values.invoice_lines = values.invoice_lines.map((line, i) => ({
      ...line,
      invoice_line_identifier: str(document.lines[i]?.id) ?? null,
      invoiced_item_vat_category_code: str(document.lines[i]?.vatCategoryId) ?? null,
    }))
  }
  return { values, extraction }
}

function moneyKey(value: number): number {
  return roundOre(value)
}

/** One comparable form of a list value: money to the öre, the breakdown in rate order. */
function listKey(field: 'vat_breakdown' | 'invoice_lines', value: unknown): string {
  if (!Array.isArray(value)) return ''
  if (field === 'vat_breakdown') {
    const rows = (value as ReadingVatBreakdownEntry[]).map((e) => [
      moneyKey(e.vat_category_rate),
      moneyKey(e.vat_category_taxable_amount),
      moneyKey(e.vat_category_tax_amount),
    ])
    rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    return JSON.stringify(rows)
  }
  return JSON.stringify(
    (value as ReadingInvoiceLine[]).map((l) => [
      collapse(l.item_name),
      l.invoiced_quantity,
      l.item_net_price === null ? null : moneyKey(l.item_net_price),
      moneyKey(l.invoice_line_net_amount),
      l.invoiced_item_vat_rate,
    ]),
  )
}

const IDENTIFIER_FIELDS: ReadonlySet<ReadingFieldName> = new Set([
  'seller_legal_registration_identifier',
  'seller_vat_identifier',
  'payment_account_bankgiro',
  'payment_account_plusgiro',
  'payment_account_iban',
  'payment_service_provider_identifier',
  'remittance_information',
])

/**
 * Whether two sources hold the same value for a field: identifiers ignoring
 * spaces and hyphens, amounts to the öre, lists row by row, text after
 * collapsing whitespace. An absent value equals only an absent one.
 */
export function sameValue(field: ReadingFieldName, a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return (a ?? null) === (b ?? null)
  if (IDENTIFIER_FIELDS.has(field)) return alnum(a) === alnum(b)
  if (field === 'amount_due_for_payment') return typeof a === 'number' && typeof b === 'number' && equalOre(a, b)
  if (field === 'vat_breakdown' || field === 'invoice_lines') return listKey(field, a) === listKey(field, b)
  if (field === 'invoice_currency_code') return alnum(a) === alnum(b)
  return collapse(a) === collapse(b)
}

// ---------------------------------------------------------------------------
// The Arkiv record: a second, independent reading with page and quote
// ---------------------------------------------------------------------------

/** One field of a stored Arkiv record (lib/documents/extract/fields.ts ExtractedField), as read back. */
export interface ArkivRecordField {
  value?: unknown
  normalized?: unknown
  page?: unknown
  quote?: unknown
}

export interface ArkivRecord {
  schema_type: string
  payload: Record<string, ArkivRecordField>
}

/** Which Arkiv schema field reads the same business term, per schema (lib/documents/extract/schemas.ts). */
const ARKIV_FIELDS: Partial<Record<ReadingFieldName, Record<string, string>>> = {
  seller_name: { receipt: 'merchant_name', supplier_invoice: 'supplier_name', credit_note: 'supplier_name', generic: 'counterparty_name' },
  seller_legal_registration_identifier: {
    receipt: 'merchant_org_number',
    supplier_invoice: 'supplier_org_number',
    credit_note: 'supplier_org_number',
    generic: 'counterparty_org_number',
  },
  invoice_number: { receipt: 'receipt_number', supplier_invoice: 'invoice_number', credit_note: 'credit_note_number' },
  invoice_issue_date: { receipt: 'receipt_date', supplier_invoice: 'invoice_date', credit_note: 'credit_date', generic: 'document_date' },
  payment_due_date: { supplier_invoice: 'due_date' },
  invoice_currency_code: { receipt: 'currency', supplier_invoice: 'currency', credit_note: 'currency', generic: 'currency' },
  amount_due_for_payment: { receipt: 'total_amount', supplier_invoice: 'total_amount', credit_note: 'total_amount', generic: 'total_amount' },
  remittance_information: { supplier_invoice: 'ocr_reference' },
  payment_account_bankgiro: { supplier_invoice: 'bankgiro' },
  payment_account_plusgiro: { supplier_invoice: 'plusgiro' },
  preceding_invoice_reference: { credit_note: 'invoice_reference' },
}

function arkivFieldFor(field: ReadingFieldName, record: ArkivRecord | null): ArkivRecordField | null {
  if (!record) return null
  const name = ARKIV_FIELDS[field]?.[record.schema_type]
  const stored = name ? record.payload[name] : undefined
  return isRecord(stored) ? stored : null
}

function arkivSays(field: ReadingFieldName, value: unknown, stored: ArkivRecordField): boolean {
  const theirs = stored.normalized ?? stored.value
  if (theirs === null || theirs === undefined || value === null || value === undefined) return false
  switch (field) {
    case 'amount_due_for_payment':
      // A credit note's Arkiv record prints the credited amount positive; the inbox books it below zero.
      return typeof value === 'number' && typeof theirs === 'number' && equalOre(Math.abs(value), Math.abs(theirs))
    case 'seller_legal_registration_identifier':
      return (normalizeOrgNumber(String(value)) ?? alnum(value)) === (normalizeOrgNumber(String(theirs)) ?? alnum(theirs))
    case 'invoice_issue_date':
    case 'payment_due_date':
      return normalizeDate(String(value)) !== null && normalizeDate(String(value)) === normalizeDate(String(theirs))
    case 'seller_name':
      return letters(value) !== '' && letters(value) === letters(theirs)
    default:
      return alnum(value) !== '' && alnum(value) === alnum(theirs)
  }
}

/**
 * Whether the Arkiv record read the same value, and where it stands: the
 * page and the quote are attached only when the record agrees, since a quote
 * of a different value would point at the wrong text.
 */
export function arkivAgreement(
  field: ReadingFieldName,
  value: unknown,
  record: ArkivRecord | null,
): { agrees: boolean; page?: number; quote?: string } {
  const stored = arkivFieldFor(field, record)
  if (!stored || !arkivSays(field, value, stored)) return { agrees: false }
  const page = typeof stored.page === 'number' && Number.isInteger(stored.page) && stored.page > 0 ? stored.page : undefined
  const quote = str(stored.quote)
  return { agrees: true, ...(page !== undefined ? { page } : {}), ...(quote !== undefined ? { quote } : {}) }
}

/** The inbox kind an Arkiv document type stands for, when it is one of them. */
export function inboxKindOfDocType(docType: string | null | undefined): ReadingValues['document_type'] | null {
  return docType === 'receipt' || docType === 'supplier_invoice' || docType === 'credit_note' ? docType : null
}

// ---------------------------------------------------------------------------
// Corroboration of a machine value
// ---------------------------------------------------------------------------

/** The matched supplier's card, as the register holds it. */
export interface SupplierCard {
  name: string | null
  org_number: string | null
  vat_number: string | null
  bankgiro: string | null
  plusgiro: string | null
  iban: string | null
}

export interface CorroborationContext {
  /** The resolved value of every field, whatever its source: cross-field checks read these. */
  values: ReadingValueMap
  arkiv: ArkivRecord | null
  supplier: SupplierCard | null
  /** Öresavrundning read with the amount due, for the VAT breakdown sum. */
  roundingAmount: number | null
}

function registerSays(field: ReadingFieldName, value: unknown, card: SupplierCard | null): boolean {
  if (!card || value === null || value === undefined) return false
  const held =
    field === 'seller_name'
      ? card.name
      : field === 'seller_legal_registration_identifier'
        ? card.org_number
        : field === 'seller_vat_identifier'
          ? card.vat_number
          : field === 'payment_account_bankgiro'
            ? card.bankgiro
            : field === 'payment_account_plusgiro'
              ? card.plusgiro
              : field === 'payment_account_iban'
                ? card.iban
                : null
  if (!held) return false
  if (field === 'seller_name') return letters(held) !== '' && letters(held) === letters(value)
  return alnum(held) !== '' && alnum(held) === alnum(value)
}

/** A Swedish VAT number is SE, the ten-digit organisationsnummer and 01. */
function vatIdentifierAgrees(values: ReadingValueMap): boolean {
  const org = values.seller_legal_registration_identifier ? normalizeOrgNumber(values.seller_legal_registration_identifier) : null
  const vat = values.seller_vat_identifier ? alnum(values.seller_vat_identifier) : null
  return org !== null && vat !== null && vat === `SE${org}01`
}

/** The breakdown's taxable amounts and VAT, with the öresavrundning, add up to the amount due (one öre per row of slack). */
function breakdownAddsUp(values: ReadingValueMap, roundingAmount: number | null): boolean {
  const total = values.amount_due_for_payment
  const rows = values.vat_breakdown
  if (total === undefined || !rows || rows.length === 0) return false
  const sum = sumOre(rows.flatMap((r) => [r.vat_category_taxable_amount, r.vat_category_tax_amount]))
  const expected = roundOre(sum + (roundingAmount ?? 0))
  return Math.abs(roundOre(total - expected)) <= roundOre(0.01 * rows.length)
}

/** What agrees with a machine value of `field`; empty when nothing does (Trolig). */
export function corroborationsFor(field: ReadingFieldName, value: unknown, ctx: CorroborationContext): Corroboration[] {
  const found: Corroboration[] = []
  if (arkivAgreement(field, value, ctx.arkiv).agrees) found.push('second_reading')
  if (registerSays(field, value, ctx.supplier)) found.push('supplier_register')
  if ((field === 'seller_legal_registration_identifier' || field === 'seller_vat_identifier') && vatIdentifierAgrees(ctx.values)) {
    found.push('vat_identifier')
  }
  if ((field === 'amount_due_for_payment' || field === 'vat_breakdown') && breakdownAddsUp(ctx.values, ctx.roundingAmount)) {
    found.push('vat_breakdown')
  }
  return found
}
