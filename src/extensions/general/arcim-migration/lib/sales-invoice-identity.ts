/**
 * How the migration wizard recognises a customer invoice it already holds.
 *
 * A numbered invoice is its invoice number: UNIQUE per company
 * (idx_invoices_company_invoice_number), so the number alone is the identity.
 *
 * A number-less invoice has none. Bokio numbers a document when it is
 * published, so its drafts (and the drafts later cancelled) arrive without
 * one and are stored with a NULL number (crm#1084). Such an invoice is
 * recognised by (customer, invoice date, currency, amount) instead: the same
 * rule supplier-invoice-identity.ts applies to number-less supplier
 * invoices. Without it a number-less invoice would be imported again on
 * every re-run.
 *
 * Imports before this rule stored the provider's record id as the number of
 * a number-less Bokio draft; `listedSalesInvoiceKeys` also yields that legacy
 * key, so a re-run never duplicates those rows either.
 */

export interface ExistingSalesInvoiceIdentity {
  invoice_number: string | null
  customer_id: string | null
  invoice_date: string | null
  currency: string | null
  total: number | string | null
}

export interface ListedSalesInvoiceIdentity {
  id: string
  invoiceNumber: string
  issueDate: string
  currencyCode: string
  legalMonetaryTotal: { payableAmount: { value: number } }
}

const numberKey = (number: string): string => `number::${number}`

/** Amount in öre, sign-agnostic: a credit note is stored negative, listed as the provider states it. */
function amountKey(value: number | string | null | undefined): string | null {
  const n = Number(value)
  return Number.isFinite(n) ? String(Math.round(Math.abs(n) * 100)) : null
}

function numberlessKey(
  customerId: string,
  date: string | null | undefined,
  currency: string | null | undefined,
  total: number | string | null | undefined,
): string | null {
  const amount = amountKey(total)
  const day = date?.slice(0, 10)
  return day && amount !== null ? `${customerId}::no-number::${day}::${(currency || 'SEK').toUpperCase()}::${amount}` : null
}

/** The one key an existing invoices row is known by, or null when it has none. */
export function existingSalesInvoiceKey(row: ExistingSalesInvoiceIdentity): string | null {
  if (row.invoice_number) return numberKey(row.invoice_number)
  if (!row.customer_id) return null
  return numberlessKey(row.customer_id, row.invoice_date, row.currency, row.total)
}

/**
 * Every key a listed provider invoice may already be stored under.
 * `customerId` is the customer the invoice resolves to in the register, or
 * null when it resolves to none (then no number-less row can be it). The
 * number is compared exactly as mapSalesInvoice stores it.
 */
export function listedSalesInvoiceKeys(dto: ListedSalesInvoiceIdentity, customerId: string | null): string[] {
  if (dto.invoiceNumber) return [numberKey(dto.invoiceNumber)]
  const keys: string[] = []
  if (dto.id) keys.push(numberKey(dto.id))
  if (customerId) {
    const key = numberlessKey(customerId, dto.issueDate, dto.currencyCode, dto.legalMonetaryTotal.payableAmount.value)
    if (key) keys.push(key)
  }
  return keys
}
