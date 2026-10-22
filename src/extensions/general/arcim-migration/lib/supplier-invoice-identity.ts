/**
 * How the provider import recognises a supplier invoice it already holds.
 *
 * A numbered invoice is the pair (supplier, supplier's invoice number), the
 * same pair the UNIQUE index on supplier_invoices enforces.
 *
 * A number-less invoice has no such pair. It is stored with a NULL number
 * (never a stand-in: the field is the supplier's own number), so it is
 * recognised by (supplier, invoice date, amount) instead. Without this a
 * number-less invoice would be imported again on every re-run.
 *
 * Imports before this rule stored the provider's record id as the number of a
 * number-less Bokio invoice; `listedInvoiceKeys` also yields that legacy key
 * so a re-run never duplicates those rows either.
 *
 * Fortnox numbers every supplier invoice itself (löpnummer, `GivenNumber`, the
 * record id its mapper hands on), apart from the number the supplier printed
 * (`InvoiceNumber`, the supplier number since crm#1157). An invoice imported
 * from Fortnox keeps the löpnummer in `fortnox_number`, unique per company,
 * and a Fortnox record is known by it first. A row without one is matched
 * only where it cannot be another Fortnox record: an import from before that
 * column, which holds the löpnummer as its supplier number, or an invoice
 * entered by hand with the supplier's number and the same date and amount.
 * The supplier number alone never identifies a Fortnox record: suppliers
 * reuse one on invoice after invoice (crm#1039).
 */

export interface ExistingSupplierInvoiceIdentity {
  supplier_id: string | null
  supplier_invoice_number: string | null
  invoice_date: string | null
  total: number | string | null
  fortnox_number?: string | null
}

export interface ListedSupplierInvoiceIdentity {
  id: string
  invoiceNumber: string
  issueDate: string
  legalMonetaryTotal: { payableAmount: { value: number } }
}

/** Fortnox's own number for a listed record (its löpnummer); null for any other provider. */
export function fortnoxNumberOf(provider: string, dto: { id: string }): string | null {
  return provider === 'fortnox' && dto.id?.trim() ? dto.id.trim() : null
}

const fortnoxKey = (number: string): string => `fortnox::${number}`

/** Amount in öre, sign-agnostic: a credit note may be stored with either sign. */
function amountKey(value: number | string | null | undefined): string | null {
  const n = Number(value)
  return Number.isFinite(n) ? String(Math.round(Math.abs(n) * 100)) : null
}

function numberlessKey(supplierId: string, date: string | null | undefined, total: number | string | null | undefined): string | null {
  const amount = amountKey(total)
  return date && amount !== null ? `${supplierId}::no-number::${date}::${amount}` : null
}

/** The one key an existing supplier_invoices row is known by. */
export function existingInvoiceKey(row: ExistingSupplierInvoiceIdentity): string | null {
  if (!row.supplier_id) return null
  if (row.supplier_invoice_number) return `${row.supplier_id}::${row.supplier_invoice_number}`
  return numberlessKey(row.supplier_id, row.invoice_date, row.total)
}

/** A row without a löpnummer, as a Fortnox record may find it: by number alone, or by number and header. */
const unstampedKey = (key: string): string => `unstamped::${key}`

function headerKey(supplierId: string, number: string, date: string | null | undefined, total: number | string | null | undefined): string | null {
  const amount = amountKey(total)
  return date && amount !== null ? `${supplierId}::${number}::${date.slice(0, 10)}::${amount}` : null
}

/** Every key an existing supplier_invoices row is known by: its löpnummer first, for a Fortnox import. */
export function existingInvoiceKeys(row: ExistingSupplierInvoiceIdentity): string[] {
  const own = existingInvoiceKey(row)
  if (row.fortnox_number) return [fortnoxKey(row.fortnox_number), ...(own ? [own] : [])]
  if (!own || !row.supplier_id) return own ? [own] : []
  const header = row.supplier_invoice_number
    ? headerKey(row.supplier_id, row.supplier_invoice_number, row.invoice_date, row.total) : null
  return [own, unstampedKey(own), ...(header ? [unstampedKey(header)] : [])]
}

/**
 * Every key a listed provider invoice may already be stored under. A
 * whitespace-only number counts as none: the mapper stores it as NULL.
 */
export function listedInvoiceKeys(supplierId: string, dto: ListedSupplierInvoiceIdentity, provider = ''): string[] {
  const keys: string[] = []
  const fortnox = fortnoxNumberOf(provider, dto)
  if (fortnox) {
    keys.push(fortnoxKey(fortnox), unstampedKey(`${supplierId}::${fortnox}`))
    const number = dto.invoiceNumber?.trim()
    const copy = number
      ? headerKey(supplierId, number, dto.issueDate, dto.legalMonetaryTotal?.payableAmount?.value)
      : numberlessKey(supplierId, dto.issueDate, dto.legalMonetaryTotal?.payableAmount?.value)
    if (copy) keys.push(unstampedKey(copy))
    return [...new Set(keys)]
  }
  if (dto.invoiceNumber?.trim()) {
    keys.push(`${supplierId}::${dto.invoiceNumber}`)
  } else {
    const numberless = numberlessKey(supplierId, dto.issueDate, dto.legalMonetaryTotal?.payableAmount?.value)
    if (numberless) keys.push(numberless)
    if (dto.id) keys.push(`${supplierId}::${dto.id}`)
  }
  return [...new Set(keys)]
}

/**
 * The number a listed provider invoice is matched to a stored row on: the
 * löpnummer for a Fortnox record, the supplier's number for any other.
 */
export function listedMatchNumber(provider: string, dto: { id: string; invoiceNumber: string }): string | null {
  return fortnoxNumberOf(provider, dto) ?? dto.invoiceNumber
}

/**
 * The number a stored row is matched to a listed provider invoice on: for
 * Fortnox its löpnummer, which a row imported before fortnox_number existed
 * holds as its supplier number.
 */
export function storedMatchNumber(
  provider: string,
  row: { supplier_invoice_number: string | null; fortnox_number?: string | null },
): string | null {
  return provider === 'fortnox' ? (row.fortnox_number ?? row.supplier_invoice_number) : row.supplier_invoice_number
}

/** What the import does with a record's supplier number. */
export type SupplierNumberPlan = 'keep' | 'asPaymentReference' | 'numberTaken'

export interface SupplierNumberRow {
  supplier_id: string | null
  supplier_invoice_number: string | null
  payment_reference?: string | null
  invoice_date: string | null
  status?: string | null
}

const outsideNumberIndex = (status: string | null | undefined): boolean => status === 'credited' || status === 'reversed'

/**
 * The supplier numbers live invoices hold, for the /migrate import of Fortnox
 * supplier invoices: the rule commit_provider_migration_records applies to
 * the background import (crm#1039, migration 20261006184512). A supplier may
 * print one reference on invoice after invoice (an autogiro or contract
 * number), and idx_supplier_invoices_company_supplier_number lets only one
 * live invoice per supplier hold a number:
 *
 * - the same number on another invoice date is another invoice: it is stored
 *   without a number, the reference kept as its payment_reference;
 * - the same number and date (also against an invoice stored that way), or a
 *   record that already carries another payment reference, is refused.
 *
 * Only for Fortnox, whose records are found again by their löpnummer: an
 * invoice stored without a number is still recognised on the next run.
 */
export function supplierNumberLedger(rows: SupplierNumberRow[]): {
  plan: (row: SupplierNumberRow) => SupplierNumberPlan
  record: (row: SupplierNumberRow) => void
} {
  // `${supplier}::${number}` -> invoice dates of the live rows holding it as
  // their number, and of the live number-less rows keeping it as reference.
  const held = new Map<string, Set<string>>()
  const asReference = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, date: string): void => {
    map.set(key, (map.get(key) ?? new Set<string>()).add(date))
  }
  const record = (row: SupplierNumberRow): void => {
    if (!row.supplier_id || outsideNumberIndex(row.status)) return
    const date = (row.invoice_date ?? '').slice(0, 10)
    if (row.supplier_invoice_number) add(held, `${row.supplier_id}::${row.supplier_invoice_number}`, date)
    else if (row.payment_reference) add(asReference, `${row.supplier_id}::${row.payment_reference}`, date)
  }
  rows.forEach(record)
  const plan = (row: SupplierNumberRow): SupplierNumberPlan => {
    const number = row.supplier_invoice_number
    if (!row.supplier_id || !number || outsideNumberIndex(row.status)) return 'keep'
    const key = `${row.supplier_id}::${number}`
    const dates = held.get(key)
    if (!dates) return 'keep'
    const date = (row.invoice_date ?? '').slice(0, 10)
    if (dates.has(date) || asReference.get(key)?.has(date)) return 'numberTaken'
    if (row.payment_reference && row.payment_reference !== number) return 'numberTaken'
    return 'asPaymentReference'
  }
  return { plan, record }
}
