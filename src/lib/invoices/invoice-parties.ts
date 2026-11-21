/**
 * The seller's and the buyer's name and address on a faktura (crm#2080).
 *
 * A faktura states both parties' full name and address (ML (2023:200) 17 kap.
 * 24 § p.5-6). A förenklad faktura (17 kap. 26-28 §§, SKVFS 2024:16) may
 * leave the buyer out: at most 4 000 kr including moms, never for an EU sale
 * or a reverse-charge sale, and at any amount for a seller outside the VAT
 * register (17 kap. 26 § p.4). The seller is never left out.
 *
 * So issuing refuses a seller without its name or address, and a buyer
 * without one where a förenklad faktura is not allowed; elsewhere a buyer
 * without an address is a warning. issuable (issue-and-book-invoice.ts) asks
 * this for every door; the editor and the send dialog ask the same question
 * before the confirm. Pure: no client, no I/O, safe in client components.
 */
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { postalPlaceLine, type PostalAddress } from '@/lib/invoices/postal-address'
import { invoiceRequiresSellerVatNumber } from '@/lib/invoices/seller-vat-number'
import { isEuVatAreaCountry, normalizeCountryCode } from '@/lib/vat/country-codes'
import type { CompanySettings, Customer, Invoice } from '@/types'

/**
 * The note on a förenklad faktura issued without the buyer's address, the
 * same words on every door that says it (the API's warnings, the MCP staged
 * note); the dashboard says it through invoice_parties.buyer_simplified.
 */
export const BUYER_ADDRESS_MISSING_WARNING = {
  code: 'BUYER_ADDRESS_MISSING',
  message_sv: 'Kunden saknar adress, så fakturan blev en förenklad faktura utan köparens adress (ML 17 kap. 26 §). Lägg till adressen på kunden för att nästa faktura ska bli fullständig.',
  message_en: "The customer has no address, so the invoice is a förenklad faktura without the buyer's address (ML 17 kap. 26 §). Add the address to the customer for a full invoice.",
} as const

/** The most a förenklad faktura may total, in kronor including moms (SKVFS 2024:16). */
export const SIMPLIFIED_INVOICE_MAX_SEK = 4000

/**
 * Whether the party has an address: a street line with the postal code or the
 * town, or the postal code and the town without a street (decided on
 * crm#2080).
 */
export function hasPostalAddress(address: PostalAddress): boolean {
  if (!!address.address_line1?.trim() && postalPlaceLine(address) !== null) return true
  return !!address.postal_code?.trim() && !!address.city?.trim()
}

export type InvoicePartiesVerdict =
  /** Both parties are named with an address, or the document is not a faktura. */
  | 'ok'
  /** The company's name or address is missing: refused. */
  | 'seller_missing'
  /** The buyer's name or address is missing and a förenklad faktura is not allowed: refused. */
  | 'buyer_missing'
  /** The buyer's name or address is missing on what may be a förenklad faktura: a warning. */
  | 'buyer_missing_simplified'

export type InvoicePartiesInvoice = Pick<Invoice, 'credited_invoice_id' | 'document_type' | 'total' | 'currency' | 'vat_treatment'>
  & Partial<Pick<Invoice, 'total_sek' | 'exchange_rate'>>

export type InvoicePartiesCustomer = Pick<Customer, 'name' | 'customer_type'> & PostalAddress

export type InvoicePartiesSeller = Pick<CompanySettings, 'company_name' | 'vat_registered'> & PostalAddress

/**
 * Whether a förenklad faktura is allowed for this sale. An EU sale is a
 * customer in another EU country or an EU business; an amount that cannot be
 * stated in kronor is not shown to be within the limit.
 */
function simplifiedInvoiceAllowed(
  invoice: InvoicePartiesInvoice,
  customer: InvoicePartiesCustomer,
  seller: InvoicePartiesSeller,
): boolean {
  if (invoice.vat_treatment === 'reverse_charge' || invoice.vat_treatment === 'reverse_charge_domestic') return false
  const country = normalizeCountryCode(customer.country)
  if (customer.customer_type === 'eu_business' || (country !== null && country !== 'SE' && isEuVatAreaCountry(country))) {
    return false
  }
  if (seller.vat_registered === false) return true
  const totalSek = resolveSekAmountOrNull(Number(invoice.total), invoice.total_sek, invoice.currency, invoice.exchange_rate)
  return totalSek !== null && totalSek <= SIMPLIFIED_INVOICE_MAX_SEK
}

/**
 * The parties a faktura must name, for this draft. `customer` undefined means
 * the caller did not select it, which says nothing about the buyer; a draft
 * with no customer at all is refused before this (invoiceLacksCustomer).
 */
export function invoicePartiesVerdict(
  invoice: InvoicePartiesInvoice,
  customer: InvoicePartiesCustomer | null | undefined,
  seller: InvoicePartiesSeller,
): InvoicePartiesVerdict {
  // The documents ML 17 kap. 24 § applies to: not a credit note, quote,
  // proforma or följesedel.
  if (!invoiceRequiresSellerVatNumber(invoice)) return 'ok'
  if (!seller.company_name?.trim() || !hasPostalAddress(seller)) return 'seller_missing'
  if (!customer) return 'ok'
  if (customer.name?.trim() && hasPostalAddress(customer)) return 'ok'
  return simplifiedInvoiceAllowed(invoice, customer, seller) ? 'buyer_missing_simplified' : 'buyer_missing'
}
