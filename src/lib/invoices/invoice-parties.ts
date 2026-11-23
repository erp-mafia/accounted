/**
 * The seller's and the buyer's name and address on a faktura, as
 * mervärdesskattelagen (2023:200) 17 kap. asks for them (crm#2080):
 *
 *   - 24 § p.5-6: a faktura issued under 10, 11 or 14 § states the seller's
 *     and the buyer's full name and address.
 *   - 10 and 11 §§: that is every sale to a business or another legal person,
 *     and a sale to a private person only for construction or installation
 *     work (11 § p.3), a new means of transport or a distance sale into
 *     Sweden. A private buyer is asked for here when a line carries a ROT or
 *     grön teknik deduction (work on the buyer's home); any other invoice to a
 *     private person is outside 24 §.
 *   - 12 §: no invoice is needed for most exempt supplies (real estate,
 *     healthcare, education, insurance, finance and more). A domestic sale on
 *     which a VAT-registered seller charges no VAT is such an exempt supply,
 *     and nothing on it says it is one of the few that still need an invoice,
 *     so it is not asked either.
 *   - 26 §: a förenklad faktura may be issued when the total is at most
 *     4 000 kr including moms (p.1), for a credit note (p.3, never asked here)
 *     or by a seller under the small-business exemption of 18 kap. (p.4): a
 *     seller outside the VAT register, which 18 kap. 4 and 8 §§ exempt up to
 *     120 000 kr a year without a decision.
 *   - 27 §: never where the buyer in another EU country pays the VAT: a
 *     reverse-charge sale, or an EU business buying from a seller outside the
 *     VAT register (a service is then supplied in the buyer's country, 7 §). A
 *     domestic reverse charge is not excluded.
 *   - 28 §: a förenklad faktura identifies the seller and needs nothing about
 *     the buyer.
 *
 * So issuing refuses a missing name or address only where a full faktura is
 * required, and says so where a förenklad faktura goes out without it.
 * issuable (issue-and-book-invoice.ts) asks this for every door that issues
 * through it (Peppol's own BIS validation asks for both addresses); the
 * editor and the send dialog ask the same question before the confirm. Pure:
 * no client, no I/O, safe in client components.
 */
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import type { PostalAddress } from '@/lib/invoices/postal-address'
import { invoiceRequiresSellerVatNumber } from '@/lib/invoices/seller-vat-number'
import { isEuVatAreaCountry, normalizeCountryCode } from '@/lib/vat/country-codes'
import type { CompanySettings, Customer, DeductionType, Invoice } from '@/types'

/**
 * The note on a förenklad faktura issued without the seller's name or
 * address, the same words on every door that says it (the API's warnings,
 * the MCP staged note); the dashboard says it through
 * invoice_parties.seller_simplified.
 */
export const SELLER_ADDRESS_MISSING_WARNING = {
  code: 'SELLER_ADDRESS_MISSING',
  message_sv: 'Företagets namn eller adress saknas, så fakturan blev en förenklad faktura utan säljarens adress (ML 17 kap. 26 och 28 §§). Fyll i dem under Inställningar → Företagsuppgifter för att nästa faktura ska bli fullständig.',
  message_en: "The company's name or address is missing, so the invoice is a förenklad faktura without the seller's address (ML 17 kap. 26 and 28 §§). Fill them in under Inställningar → Företagsuppgifter (Settings → Company details) for a full invoice.",
} as const

/** The same for the buyer; the dashboard says it through invoice_parties.buyer_simplified. */
export const BUYER_ADDRESS_MISSING_WARNING = {
  code: 'BUYER_ADDRESS_MISSING',
  message_sv: 'Kundens namn eller adress saknas, så fakturan blev en förenklad faktura utan köparens uppgifter (ML 17 kap. 26 och 28 §§). Lägg till dem på kunden för att nästa faktura ska bli fullständig.',
  message_en: "The customer's name or address is missing, so the invoice is a förenklad faktura without the buyer's details (ML 17 kap. 26 and 28 §§). Add them to the customer for a full invoice.",
} as const

/** The most a förenklad faktura may total, in kronor including moms (ML 17 kap. 26 § p.1). */
export const SIMPLIFIED_INVOICE_MAX_SEK = 4000

/**
 * Whether the party has an address. On a faktura that is a postal address,
 * a place post is delivered to such as a street or a box address
 * (Skatteverket, ställningstagande 2025-12-16, dnr 8-399536-2025): a street
 * line with the postal code or the town, or the postal code and the town
 * without a street (a company's own postal code). A town, a postal code or
 * a state alone is not one.
 */
export function hasPostalAddress(address: PostalAddress): boolean {
  const street = !!address.address_line1?.trim() || !!address.address_line2?.trim()
  const postalCode = !!address.postal_code?.trim()
  const town = !!address.city?.trim()
  return (street && (postalCode || town)) || (postalCode && town)
}

export type InvoicePartiesVerdict =
  /** Both parties are named with an address, or the law asks nothing of this document. */
  | 'ok'
  /**
   * A full faktura without the company's name or address, or a förenklad
   * one with nothing that identifies the company: refused.
   */
  | 'seller_missing'
  /** A full faktura without the buyer's name or address: refused. */
  | 'buyer_missing'
  /** A förenklad faktura without the company's name or address: a warning. */
  | 'seller_missing_simplified'
  /** A förenklad faktura without the buyer's name or address: a warning. */
  | 'buyer_missing_simplified'

export type InvoicePartiesInvoice = Pick<Invoice, 'credited_invoice_id' | 'document_type' | 'total' | 'vat_amount' | 'currency' | 'vat_treatment'>
  & Partial<Pick<Invoice, 'total_sek' | 'exchange_rate'>>
  & {
    /**
     * The lines' deductions: a ROT or grön teknik line is construction work on
     * a private buyer's home. Lines the caller did not load leave a private
     * buyer's invoice asked for, as if it were construction work.
     */
    items?: ReadonlyArray<{ deduction_type?: DeductionType | null }> | null
  }

export type InvoicePartiesCustomer = Pick<Customer, 'name' | 'customer_type'> & PostalAddress

export type InvoicePartiesSeller = Pick<CompanySettings, 'company_name' | 'org_number' | 'vat_registered' | 'vat_number'> & PostalAddress

/** The deductions for construction or installation work on a home (ML 17 kap. 11 § p.3). */
const CONSTRUCTION_DEDUCTIONS: ReadonlySet<DeductionType> = new Set<DeductionType>(['rot', 'gron_teknik'])

/** The treatments of a domestic sale, on which a VAT-registered seller charges Swedish VAT unless it is exempt. */
const DOMESTIC_TREATMENTS: ReadonlySet<Invoice['vat_treatment']> = new Set<Invoice['vat_treatment']>([
  'standard_25',
  'reduced_12',
  'reduced_6',
  'exempt',
])

/**
 * Whether 17 kap. 24 § asks for the parties at all: a faktura issued under
 * 10 or 11 §. A sale to a business or another legal person is one, unless it
 * is an exempt supply 12 § frees from the invoice (a VAT-registered seller's
 * domestic sale without VAT); a sale to a private person only as
 * construction or installation work (11 § p.3).
 */
function fullContentRulesApply(
  invoice: InvoicePartiesInvoice,
  customer: InvoicePartiesCustomer,
  seller: InvoicePartiesSeller,
): boolean {
  const exemptDomesticSale = seller.vat_registered !== false
    && DOMESTIC_TREATMENTS.has(invoice.vat_treatment)
    && Number(invoice.vat_amount) === 0
  if (exemptDomesticSale) return false
  if (customer.customer_type !== 'individual') return true
  if (!invoice.items) return true
  return invoice.items.some((item) => !!item.deduction_type && CONSTRUCTION_DEDUCTIONS.has(item.deduction_type))
}

/** An EU business in another EU country (or of no stated country). */
function isEuBusinessAbroad(customer: InvoicePartiesCustomer): boolean {
  if (customer.customer_type !== 'eu_business') return false
  const country = normalizeCountryCode(customer.country)
  return country === null || (country !== 'SE' && isEuVatAreaCountry(country))
}

/**
 * Whether a förenklad faktura is allowed for this sale (17 kap. 26-27 §§).
 * An amount that cannot be stated in kronor is not shown to be within the
 * limit.
 */
function simplifiedInvoiceAllowed(
  invoice: InvoicePartiesInvoice,
  customer: InvoicePartiesCustomer,
  seller: InvoicePartiesSeller,
): boolean {
  // 27 §: the buyer in another EU country pays the VAT.
  if (invoice.vat_treatment === 'reverse_charge') return false
  if (seller.vat_registered === false) {
    // A seller outside the VAT register charges no VAT, so its treatment says
    // nothing of where the sale is taxed: an EU business buys a service
    // supplied, and taxed on the buyer, in its own country (27 § p.2, 7 §).
    if (isEuBusinessAbroad(customer)) return false
    return true
  }
  const totalSek = resolveSekAmountOrNull(Number(invoice.total), invoice.total_sek, invoice.currency, invoice.exchange_rate)
  return totalSek !== null && totalSek <= SIMPLIFIED_INVOICE_MAX_SEK
}

/** Something on the faktura that identifies the company (28 § p.2): its name, organisationsnummer or momsregistreringsnummer. */
function sellerIdentified(seller: InvoicePartiesSeller): boolean {
  return [seller.company_name, seller.org_number, seller.vat_number].some((value) => !!value?.trim())
}

/**
 * The parties a faktura must name, for this draft. `customer` undefined means
 * the caller did not select it, which says nothing about who the buyer is; a
 * draft with no customer at all is refused before this (invoiceLacksCustomer).
 */
export function invoicePartiesVerdict(
  invoice: InvoicePartiesInvoice,
  customer: InvoicePartiesCustomer | null | undefined,
  seller: InvoicePartiesSeller,
): InvoicePartiesVerdict {
  // The documents ML 17 kap. 24 § applies to: not a credit note, quote,
  // proforma or följesedel.
  if (!invoiceRequiresSellerVatNumber(invoice)) return 'ok'
  if (!customer || !fullContentRulesApply(invoice, customer, seller)) return 'ok'
  const simplified = simplifiedInvoiceAllowed(invoice, customer, seller)
  const sellerNamed = !!seller.company_name?.trim() && hasPostalAddress(seller)
  const buyerNamed = !!customer.name?.trim() && hasPostalAddress(customer)
  if (!sellerNamed && (!simplified || !sellerIdentified(seller))) return 'seller_missing'
  if (!buyerNamed && !simplified) return 'buyer_missing'
  if (!sellerNamed) return 'seller_missing_simplified'
  if (!buyerNamed) return 'buyer_missing_simplified'
  return 'ok'
}

/** The note a förenklad faktura goes out with (the API's warnings, the MCP staged note), or null. */
export function simplifiedInvoiceWarning(
  verdict: InvoicePartiesVerdict,
): typeof SELLER_ADDRESS_MISSING_WARNING | typeof BUYER_ADDRESS_MISSING_WARNING | null {
  if (verdict === 'seller_missing_simplified') return SELLER_ADDRESS_MISSING_WARNING
  if (verdict === 'buyer_missing_simplified') return BUYER_ADDRESS_MISSING_WARNING
  return null
}
