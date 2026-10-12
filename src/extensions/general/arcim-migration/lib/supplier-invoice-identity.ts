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
 * record id its mapper hands on), apart from the number the supplier printed.
 * An invoice imported from Fortnox keeps it in `fortnox_number`, unique per
 * company, and a Fortnox record is known by it first (crm#1157). Imports
 * before that column stored the löpnummer as the supplier number, so a Fortnox
 * record also matches a row of its supplier that carries the löpnummer there.
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

/** Every key an existing supplier_invoices row is known by: its löpnummer first, for a Fortnox import. */
export function existingInvoiceKeys(row: ExistingSupplierInvoiceIdentity): string[] {
  const own = existingInvoiceKey(row)
  return [...(row.fortnox_number ? [fortnoxKey(row.fortnox_number)] : []), ...(own ? [own] : [])]
}

/**
 * Every key a listed provider invoice may already be stored under. A
 * whitespace-only number counts as none: the mapper stores it as NULL.
 */
export function listedInvoiceKeys(supplierId: string, dto: ListedSupplierInvoiceIdentity, provider = ''): string[] {
  const keys: string[] = []
  const fortnox = fortnoxNumberOf(provider, dto)
  if (fortnox) keys.push(fortnoxKey(fortnox), `${supplierId}::${fortnox}`)
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
