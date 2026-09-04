import type { CustomerType, VatTreatment } from '@/types'
import { countryPermitsReverseCharge } from '@/lib/vat/country-codes'

export interface VatRateOption {
  rate: number
  label: string
  treatment: VatTreatment
}

/**
 * Reverse charge (0%, ruta 39) needs all three: EU-business type, a VIES-
 * validated VAT number, and a country other than Sweden (a buyer
 * established here owes Swedish VAT whatever foreign number it holds).
 * `country` undefined means the caller did not have it, which keeps the
 * pre-2026-09 behaviour (type + validation only).
 */
export function isReverseChargeCustomer(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
  country?: string | null,
): boolean {
  return (
    customerType === 'eu_business' &&
    vatNumberValidated &&
    countryPermitsReverseCharge(country)
  )
}

/**
 * Get the DEFAULT VAT rates offered for invoice line items, per customer type.
 *
 * Swedish/EU-unvalidated customers can choose between 25%, 12%, 6%, and 0% (exempt).
 * Reverse charge and export customers default to a single 0% option, because
 * huvudregeln (ML 6 kap. 34 §, Article 44 VAT Directive) taxes a B2B service
 * where the buyer is established.
 *
 * This is the DEFAULT, not the full set of lawful rates: see
 * getPermittedVatRates() for the taxed-where-performed exceptions that carry
 * Swedish VAT even to a foreign business customer. Validation must gate on
 * getPermittedVatRates(); only the picker default should come from here.
 *
 * This helper does NOT gate on the seller's VAT registration status: it only
 * knows the customer side. The seller-side gate lives one level up: the invoice
 * form hides the Moms column entirely when company_settings.vat_registered is
 * false, and both the create route and the MCP commit force every line to 0%
 * (momsfri) server-side, so a non-momsregistrerad company never books output VAT.
 *
 * `country` is the customer's ISO 3166-1 alpha-2 country. Reverse charge is
 * refused when it is SE (see countryPermitsReverseCharge). An eu_business
 * row with a validated German VAT number but country SE used to get 0% here
 * and only be caught by the periodisk sammanställning after the invoice was
 * sent (#2025).
 */
export function getAvailableVatRates(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
  country?: string | null,
): VatRateOption[] {
  // EU business with validated VAT → reverse charge, locked to 0%
  if (isReverseChargeCustomer(customerType, vatNumberValidated, country)) {
    return [{ rate: 0, label: '0% (omvänd skattskyldighet)', treatment: 'reverse_charge' }]
  }

  // Non-EU → export, locked to 0%
  if (customerType === 'non_eu_business') {
    return [{ rate: 0, label: '0% (export)', treatment: 'export' }]
  }

  // Swedish customers (or EU without validated VAT) can choose any rate
  return [
    { rate: 25, label: '25%', treatment: 'standard_25' },
    { rate: 12, label: '12%', treatment: 'reduced_12' },
    { rate: 6, label: '6%', treatment: 'reduced_6' },
    { rate: 0, label: '0% (momsfritt)', treatment: 'exempt' },
  ]
}

/**
 * The set of VAT rates an article's stored rate may be ADOPTED from when the
 * article prefills an invoice line (web line picker parity: the picker only
 * adopts a rate the customer could have picked themselves). Empty when the
 * customer is locked to a single rate (foreign business 0% reverse charge /
 * export): an article's stored rate is its DOMESTIC rate, and adopting it
 * there would silently put Swedish VAT on a reverse-charge or export invoice
 * even though the wider permitted set would accept it. This governs PREFILL
 * only; every validation gate keeps using getPermittedVatRates().
 */
export function getArticleVatRateAdoptionSet(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
  country?: string | null,
): ReadonlySet<number> {
  const offered = getAvailableVatRates(customerType, vatNumberValidated, country)
  return new Set(offered.length > 1 ? offered.map((r) => r.rate) : [])
}

/**
 * Get the VAT rates that may LEGALLY appear on an invoice line for this
 * customer type. This is the set validation must gate on.
 *
 * Distinct from getAvailableVatRates(), which is only the DEFAULT offered in
 * the picker. Under huvudregeln (ML 6 kap. 34 §, Article 44 VAT Directive)
 * "B2B services taxed where buyer established", so 0% (reverse charge for a
 * VAT-validated EU business, export outside the EU) is the right DEFAULT for a
 * foreign business customer. It is not the only lawful rate.
 *
 * ML 6 kap. (plats för transaktioner) carries exceptions that are taxed where
 * the supply is performed, and therefore carry Swedish VAT even when the buyer
 * is a foreign business. Per the swedish-vat reference, the exceptions "(taxed
 * where performed)" are:
 *
 *   - Fastighetstjänster (property location)                        25%
 *   - Persontransporter (where transport occurs)                     6%
 *   - Korttidsuthyrning transport vehicles (pickup location)        25%
 *   - Restaurang/catering (where performed)                         12%
 *   - Admission to cultural/sports events (event location)           6%
 *
 * A Stockholm hotel night or a conference ticket sold to a German or a US
 * company is such a supply. Refusing every non-zero rate for these customers
 * makes those invoices impossible to issue at all. Because the exceptions span
 * 25%, 12% and 6%, no single non-zero rate can be whitelisted instead.
 *
 * Nothing on an invoice line distinguishes "consulting for a German company"
 * (0%, reverse charge) from "hotel night in Stockholm sold to a German company"
 * (12% Swedish VAT), so this set only widens what is ACCEPTED. The default stays
 * 0% via getAvailableVatRates() and getVatRules().rate, which is also the
 * fallback when a line omits vat_rate. A Swedish rate therefore lands on such an
 * invoice only when it was set explicitly on that line.
 */
export function getPermittedVatRates(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
  country?: string | null,
): VatRateOption[] {
  const offered = getAvailableVatRates(customerType, vatNumberValidated, country)

  const isForeignBusiness =
    customerType === 'non_eu_business' ||
    isReverseChargeCustomer(customerType, vatNumberValidated, country)
  if (!isForeignBusiness) {
    return offered
  }

  // The 0% reverse-charge / export option stays FIRST so any consumer that
  // treats element 0 as the default keeps defaulting to 0%.
  return [
    ...offered,
    { rate: 25, label: '25%', treatment: 'standard_25' },
    { rate: 12, label: '12%', treatment: 'reduced_12' },
    { rate: 6, label: '6%', treatment: 'reduced_6' },
  ]
}

/**
 * Map a numeric VAT rate to a VatTreatment.
 */
export function getVatTreatmentForRate(rate: number): VatTreatment {
  switch (rate) {
    case 25:
      return 'standard_25'
    case 12:
      return 'reduced_12'
    case 6:
      return 'reduced_6'
    case 0:
      return 'exempt'
    default:
      return 'standard_25'
  }
}

export interface VatRule {
  treatment: VatTreatment
  rate: number
  momsRuta: string
  reverseChargeText?: string
}

/**
 * Determine VAT treatment based on customer type and VAT validation status.
 *
 * Rules:
 * - Swedish customers: 25% VAT, moms ruta 05
 * - EU business with validated VAT and a country other than SE: 0% reverse charge, moms ruta 39
 * - EU business without validated VAT, or with country SE: 25% VAT, moms ruta 05
 * - Non-EU business: 0% export, moms ruta 40
 *
 * Independent of the seller's VAT registration status. A non-momsregistrerad
 * seller who charges VAT still owes it under ML 16 kap. 23 § (faktureringsmoms),
 * so the rule output must reflect the rate actually charged on the line.
 */
export function getVatRules(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
  country?: string | null,
): VatRule {
  switch (customerType) {
    case 'individual':
    case 'swedish_business':
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }

    case 'eu_business':
      if (isReverseChargeCustomer(customerType, vatNumberValidated, country)) {
        return {
          treatment: 'reverse_charge',
          rate: 0,
          momsRuta: '39',
          reverseChargeText: 'Omvänd skattskyldighet / Reverse charge - VAT to be accounted for by the recipient as per Article 196, Council Directive 2006/112/EC',
        }
      }
      // EU business without validated VAT number, or one whose country is
      // Sweden, must be charged Swedish VAT
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }

    case 'non_eu_business':
      return {
        treatment: 'export',
        rate: 0,
        momsRuta: '40',
        reverseChargeText: 'Omsättning utanför EU, ML 10 kap.',
      }

    default:
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }
  }
}

/**
 * Calculate VAT amount
 */
export function calculateVat(subtotal: number, vatRate: number): number {
  return Math.round(subtotal * vatRate) / 100
}

/**
 * Calculate total including VAT
 */
export function calculateTotal(subtotal: number, vatRate: number): number {
  return Math.round((subtotal + calculateVat(subtotal, vatRate)) * 100) / 100
}

/**
 * Format VAT rate for display
 */
export function formatVatRate(rate: number): string {
  if (rate === 0) {
    return '0%'
  }
  return `${rate}%`
}

/**
 * Get VAT treatment label in Swedish
 */
export function getVatTreatmentLabel(treatment: VatTreatment): string {
  const labels: Record<VatTreatment, string> = {
    standard_25: '25% moms',
    reduced_12: '12% moms',
    reduced_6: '6% moms',
    reverse_charge: 'Omvänd skattskyldighet (0%)',
    export: 'Export (0%)',
    exempt: 'Momsfritt',
  }
  return labels[treatment]
}

/**
 * Derive a display-friendly VAT summary from invoice line items.
 *
 * - If all items share a single rate → returns that rate's label and treatment
 * - If items have mixed rates → returns "Blandade momssatser" with null rate/treatment
 */
export function getVatSummaryFromItems(
  items: { vat_rate?: number | null }[]
): { label: string; treatment: VatTreatment | null; rate: number | null; isMixed: boolean } {
  const rates = new Set(items.map((item) => item.vat_rate ?? 0))

  if (rates.size === 1) {
    const rate = rates.values().next().value!
    const treatment = getVatTreatmentForRate(rate)
    return {
      label: getVatTreatmentLabel(treatment),
      treatment,
      rate,
      isMixed: false,
    }
  }

  return {
    label: 'Blandade momssatser',
    treatment: null,
    rate: null,
    isMixed: true,
  }
}

/**
 * Get moms ruta description
 */
export function getMomsRutaDescription(ruta: string): string {
  const descriptions: Record<string, string> = {
    '05': 'Utgående moms 25%',
    '06': 'Utgående moms 12%',
    '07': 'Utgående moms 6%',
    '39': 'Försäljning av tjänster till annat EU-land',
    '40': 'Export utanför EU',
  }
  return descriptions[ruta] || ruta
}
