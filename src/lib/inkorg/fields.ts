/**
 * "Uppgifter från dokumentet": the one reading of an inbox item
 * (lib/documents/reading) as a list a person reads and corrects. The panel
 * (components/inkorg/DocumentFieldsPanel.tsx) renders what this module
 * decides:
 *
 *   - which fields show, in which order (panelRows);
 *   - each value in the repo's display form (formatFieldValue);
 *   - where it came from and how far it can be trusted, as label keys
 *     (sourceLabelKey, evidenceLabelKey: a level, never a percentage);
 *   - which fields a person can correct, and the update one edited field
 *     sends to the item's existing field correction
 *     (PATCH /api/extensions/ext/invoice-inbox/items/:id/fields,
 *     UpdateInboxItemFieldsSchema), with the value the field then reads as
 *     the person's (buildFieldUpdate).
 *
 * Pure: no client, no I/O, no React. Strings are next-intl keys under the
 * `inkorg_fields` namespace.
 */
import type { UpdateInboxItemFieldsInput } from '@/lib/documents/inbox-item-actions'
import type {
  DocumentReading,
  EvidenceLevel,
  ReadingField,
  ReadingInvoiceLine,
  ReadingSource,
  ReadingValues,
  ReadingVatBreakdownEntry,
} from '@/lib/documents/reading/types'
import { formatBankgiroNumber, formatPlusgiroNumber, validateBankgiroNumber, validatePlusgiroNumber } from '@/lib/bankgiro/luhn'
import { formatIbanGroups } from '@/lib/company/connection-iban'
import { isSaneDateString, ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { formatAmountInput, parseAmountInput } from '@/lib/money'
import { formatCurrency, formatDate, formatOrgNumber } from '@/lib/utils'

/** The fields the panel lists, in the order it lists them. */
export const PANEL_FIELDS = [
  'seller_name',
  'seller_legal_registration_identifier',
  'seller_vat_identifier',
  'seller_country_code',
  'invoice_number',
  'invoice_issue_date',
  'payment_due_date',
  'invoice_currency_code',
  'amount_due_for_payment',
  'vat_breakdown',
  'remittance_information',
  'payment_account_bankgiro',
  'payment_account_plusgiro',
  'payment_account_iban',
  'preceding_invoice_reference',
  'invoice_lines',
] as const satisfies readonly (keyof ReadingValues)[]

export type PanelFieldName = (typeof PANEL_FIELDS)[number]

/**
 * The fields a person corrects through the item's field correction. The
 * country follows the VAT number, and IBAN, the VAT breakdown and the lines
 * have no place in UpdateInboxItemFieldsSchema: they are read only here.
 */
export const EDITABLE_FIELDS = [
  'seller_name',
  'seller_legal_registration_identifier',
  'seller_vat_identifier',
  'invoice_number',
  'invoice_issue_date',
  'payment_due_date',
  'invoice_currency_code',
  'amount_due_for_payment',
  'remittance_information',
  'payment_account_bankgiro',
  'payment_account_plusgiro',
  'preceding_invoice_reference',
] as const satisfies readonly PanelFieldName[]

export type EditableFieldName = (typeof EDITABLE_FIELDS)[number]

const EDITABLE: ReadonlySet<string> = new Set(EDITABLE_FIELDS)

export function isEditableField(name: PanelFieldName): name is EditableFieldName {
  return EDITABLE.has(name)
}

/** Shown even when nothing read them: what booking an underlag needs, so a person can fill them in. */
export const ALWAYS_SHOWN: readonly EditableFieldName[] = ['seller_name', 'invoice_issue_date', 'amount_due_for_payment']

/** The label key of a field (`inkorg_fields` namespace). */
export function fieldLabelKey(name: PanelFieldName): `field.${PanelFieldName}` {
  return `field.${name}`
}

/** Where a value came from, in the words the panel shows: e-faktura, text, bild, brevlåda, du. */
export function sourceLabelKey(source: ReadingSource): `source.${ReadingSource}` {
  return `source.${source}`
}

/** The evidence level as a small label: Exakt, Stark, Trolig, Ditt val. */
export function evidenceLabelKey(evidence: EvidenceLevel): `evidence.${EvidenceLevel}` {
  return `evidence.${evidence}`
}

export interface PanelRow {
  name: PanelFieldName
  /** The reading's field; null when nothing read it (an always-shown field). */
  field: ReadingField<unknown> | null
  editable: boolean
}

/**
 * The rows the panel lists: every field the reading holds (a value a person
 * cleared included), plus the always-shown ones, and on a credit note the
 * invoice it credits (ML 17 kap 22 § asks for the reference). A locked item
 * (converted to a supplier invoice) has nothing editable.
 */
export function panelRows(reading: Pick<DocumentReading, 'fields'> | null | undefined, options: { locked?: boolean } = {}): PanelRow[] {
  const fields = (reading?.fields ?? {}) as Partial<Record<PanelFieldName, ReadingField<unknown>>>
  const shown = new Set<PanelFieldName>(ALWAYS_SHOWN)
  if (reading?.fields.document_type?.value === 'credit_note') shown.add('preceding_invoice_reference')
  return PANEL_FIELDS.flatMap((name) => {
    const field = fields[name] ?? null
    if (!field && !shown.has(name)) return []
    return [{ name, field, editable: !options.locked && isEditableField(name) }]
  })
}

/** The document's currency, for its amounts: the reading's, else SEK. */
export function readingCurrency(reading: Pick<DocumentReading, 'fields'> | null | undefined): string {
  const code = reading?.fields.invoice_currency_code?.value
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code) ? code : 'SEK'
}

export interface VatRow {
  rate: string
  base: string
  tax: string
}

export interface LineRow {
  name: string
  quantity: string
  amount: string
}

export type FormattedValue =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; numeric: boolean }
  | { kind: 'vat'; rows: VatRow[] }
  | { kind: 'lines'; rows: LineRow[] }

const NUMBER = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 4 })

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function text(value: string, numeric = false): FormattedValue {
  return { kind: 'text', text: value, numeric }
}

/** A VAT rate in percent, Swedish style: "25 %", "6 %", "12,5 %". */
export function formatRate(rate: number): string {
  return `${NUMBER.format(rate)} %`
}

/** A value in the repo's display form: dates, amounts, org numbers, giro numbers, the breakdown and the lines. */
export function formatFieldValue(name: PanelFieldName, value: unknown, currency = 'SEK'): FormattedValue {
  if (value === null || value === undefined || value === '') return { kind: 'empty' }
  switch (name) {
    case 'amount_due_for_payment':
      return isNumber(value) ? text(formatCurrency(value, currency), true) : { kind: 'empty' }
    case 'invoice_issue_date':
    case 'payment_due_date':
      return text(formatDate(String(value)), true)
    case 'seller_legal_registration_identifier':
      return text(formatOrgNumber(String(value)), true)
    case 'payment_account_bankgiro':
      return text(formatBankgiroNumber(String(value)), true)
    case 'payment_account_plusgiro':
      return text(formatPlusgiroNumber(String(value)), true)
    case 'payment_account_iban':
      return text(formatIbanGroups(String(value).replace(/\s/g, '').toUpperCase()), true)
    case 'invoice_number':
    case 'remittance_information':
    case 'preceding_invoice_reference':
      return text(String(value), true)
    case 'vat_breakdown': {
      if (!Array.isArray(value) || value.length === 0) return { kind: 'empty' }
      const rows = (value as ReadingVatBreakdownEntry[]).map((row) => ({
        rate: formatRate(row.vat_category_rate),
        base: formatCurrency(row.vat_category_taxable_amount, currency),
        tax: formatCurrency(row.vat_category_tax_amount, currency),
      }))
      return { kind: 'vat', rows }
    }
    case 'invoice_lines': {
      if (!Array.isArray(value) || value.length === 0) return { kind: 'empty' }
      const rows = (value as ReadingInvoiceLine[]).map((line) => ({
        name: line.item_name,
        quantity: NUMBER.format(line.invoiced_quantity),
        amount: formatCurrency(line.invoice_line_net_amount, currency),
      }))
      return { kind: 'lines', rows }
    }
    default:
      return text(String(value))
  }
}

/** Where the value stands on the document, when a reading located it. */
export function whereRead(field: ReadingField<unknown> | null | undefined): { page?: number; quote?: string } | null {
  if (!field) return null
  const page = isNumber(field.page) && field.page > 0 ? field.page : undefined
  const quote = typeof field.quote === 'string' && field.quote.trim() ? field.quote.trim() : undefined
  if (page === undefined && quote === undefined) return null
  return { ...(page !== undefined ? { page } : {}), ...(quote !== undefined ? { quote } : {}) }
}

/** What the edit field starts with: the stored value in the form a person types it. */
export function editInputValue(name: EditableFieldName, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (name === 'amount_due_for_payment') return isNumber(value) ? formatAmountInput(value) : ''
  return String(value)
}

export type FieldUpdateError =
  | 'required'
  | 'too_long'
  | 'invalid_date'
  | 'invalid_amount'
  | 'invalid_currency'
  | 'invalid_bankgiro'
  | 'invalid_plusgiro'

export type FieldUpdate =
  | {
      ok: true
      /** The body for the item's field correction: one field, nothing else. */
      body: UpdateInboxItemFieldsInput
      /** The value the field reads after the save (null: cleared). */
      value: string | number | null
    }
  | { ok: false; error: FieldUpdateError }

/** UpdateInboxItemFieldsSchema caps a text field at 500 characters. */
const MAX_TEXT = 500

type StringPath =
  | { group: 'supplier'; key: 'name' | 'orgNumber' | 'vatNumber' | 'bankgiro' | 'plusgiro' }
  | { group: 'invoice'; key: 'invoiceNumber' | 'paymentReference' | 'creditedInvoiceNumber' }

const STRING_PATHS: Partial<Record<EditableFieldName, StringPath>> = {
  seller_name: { group: 'supplier', key: 'name' },
  seller_legal_registration_identifier: { group: 'supplier', key: 'orgNumber' },
  seller_vat_identifier: { group: 'supplier', key: 'vatNumber' },
  payment_account_bankgiro: { group: 'supplier', key: 'bankgiro' },
  payment_account_plusgiro: { group: 'supplier', key: 'plusgiro' },
  invoice_number: { group: 'invoice', key: 'invoiceNumber' },
  remittance_information: { group: 'invoice', key: 'paymentReference' },
  preceding_invoice_reference: { group: 'invoice', key: 'creditedInvoiceNumber' },
}

type SupplierFields = NonNullable<UpdateInboxItemFieldsInput['supplier']>
type InvoiceFields = NonNullable<UpdateInboxItemFieldsInput['invoice']>

function stringBody(path: StringPath, value: string | null): UpdateInboxItemFieldsInput {
  if (path.group === 'supplier') {
    const supplier: SupplierFields = {}
    supplier[path.key] = value
    return { supplier }
  }
  const invoice: InvoiceFields = {}
  invoice[path.key] = value
  return { invoice }
}

function dateBody(key: 'invoiceDate' | 'dueDate', value: string | null): UpdateInboxItemFieldsInput {
  const invoice: InvoiceFields = {}
  invoice[key] = value
  return { invoice }
}

/**
 * The correction one edited field sends, from what the person typed. An
 * empty field clears the value (null), except the currency, which every
 * reading has. Dates are YYYY-MM-DD, amounts read the way Swedish users type
 * them ("1 234,50") and are rounded to the öre, giro numbers must pass their
 * check digit.
 */
export function buildFieldUpdate(name: EditableFieldName, input: string): FieldUpdate {
  const typed = input.trim()
  switch (name) {
    case 'invoice_issue_date':
    case 'payment_due_date': {
      const key = name === 'invoice_issue_date' ? 'invoiceDate' : 'dueDate'
      if (!typed) return { ok: true, body: dateBody(key, null), value: null }
      if (!ISO_DATE_RE.test(typed) || !isSaneDateString(typed)) return { ok: false, error: 'invalid_date' }
      return { ok: true, body: dateBody(key, typed), value: typed }
    }
    case 'amount_due_for_payment': {
      if (!typed) return { ok: true, body: { totals: { total: null } }, value: null }
      const amount = parseAmountInput(typed)
      if (amount === null) return { ok: false, error: 'invalid_amount' }
      return { ok: true, body: { totals: { total: amount } }, value: amount }
    }
    case 'invoice_currency_code': {
      if (!typed) return { ok: false, error: 'required' }
      const code = typed.toUpperCase()
      if (!/^[A-Z]{3}$/.test(code)) return { ok: false, error: 'invalid_currency' }
      return { ok: true, body: { invoice: { currency: code } }, value: code }
    }
    default: {
      const path = STRING_PATHS[name]!
      if (!typed) return { ok: true, body: stringBody(path, null), value: null }
      if (typed.length > MAX_TEXT) return { ok: false, error: 'too_long' }
      if (name === 'payment_account_bankgiro' && !validateBankgiroNumber(typed)) return { ok: false, error: 'invalid_bankgiro' }
      if (name === 'payment_account_plusgiro' && !validatePlusgiroNumber(typed)) return { ok: false, error: 'invalid_plusgiro' }
      return { ok: true, body: stringBody(path, typed), value: typed }
    }
  }
}

/**
 * The field as it reads once the correction is saved: the person's value,
 * Ditt val. The page re-reads the item for the server's word; this is what
 * the panel shows until it does.
 */
export function personField(value: string | number | null, previous: ReadingField<unknown> | null): ReadingField<unknown> {
  const located = previous && previous.value === value ? whereRead(previous) : null
  return { value, source: 'person', evidence: 'ditt_val', ...(located ?? {}) }
}
