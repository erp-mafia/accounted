/**
 * Conservative header fingerprints for the legacy provider import's lookup.
 * A supplier number alone is never identity: references can recur. The durable
 * worker uses provider source IDs; adoption additionally checks the full header.
 * Legacy number-less rows may have stored the provider ID as the number.
 */
export interface ExistingSupplierInvoiceIdentity {
  supplier_id: string | null
  supplier_invoice_number: string | null
  invoice_date: string | null
  total: number | string | null
  currency?: string | null
  is_credit_note?: boolean | null
}

export interface ListedSupplierInvoiceIdentity {
  id: string
  invoiceNumber: string
  issueDate: string
  currencyCode?: string
  invoiceTypeCode?: string
  legalMonetaryTotal: { payableAmount: { value: number } }
}

function headerKey(supplierId: string, number: string | null, date: string | null, total: number | string | null,
  currency = 'SEK', credit = false): string | null {
  if (!date || total === null || total === '') return null
  const amount = Number(total)
  if (!Number.isFinite(amount)) return null
  return JSON.stringify([supplierId, number && number !== '-' ? number : null, date, currency, Math.round(Math.abs(amount) * 100), credit])
}

export function existingInvoiceKey(row: ExistingSupplierInvoiceIdentity): string | null {
  if (!row.supplier_id) return null
  return headerKey(row.supplier_id, row.supplier_invoice_number, row.invoice_date, row.total, row.currency ?? 'SEK', row.is_credit_note ?? false)
}

export function listedInvoiceKeys(supplierId: string, dto: ListedSupplierInvoiceIdentity): string[] {
  const key = (number: string | null) => headerKey(supplierId, number, dto.issueDate,
    dto.legalMonetaryTotal?.payableAmount?.value, dto.currencyCode, dto.invoiceTypeCode === '381')
  const numbered = dto.invoiceNumber && dto.invoiceNumber !== '-'
  const keys = [key(numbered ? dto.invoiceNumber : null)]
  if (!numbered && dto.id) keys.push(key(dto.id))
  return keys.filter((value): value is string => value !== null)
}
