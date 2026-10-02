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
 */

export interface ExistingSupplierInvoiceIdentity {
  supplier_id: string | null
  supplier_invoice_number: string | null
  invoice_date: string | null
  total: number | string | null
}

export interface ListedSupplierInvoiceIdentity {
  id: string
  invoiceNumber: string
  issueDate: string
  legalMonetaryTotal: { payableAmount: { value: number } }
}

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

/** Every key a listed provider invoice may already be stored under. */
export function listedInvoiceKeys(supplierId: string, dto: ListedSupplierInvoiceIdentity): string[] {
  if (dto.invoiceNumber) return [`${supplierId}::${dto.invoiceNumber}`]
  const keys: string[] = []
  const numberless = numberlessKey(supplierId, dto.issueDate, dto.legalMonetaryTotal?.payableAmount?.value)
  if (numberless) keys.push(numberless)
  if (dto.id) keys.push(`${supplierId}::${dto.id}`)
  return keys
}
