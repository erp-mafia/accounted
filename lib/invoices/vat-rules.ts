import type { CustomerType, VatTreatment } from '@/types'

export interface VatRateOption {
  rate: number
  label: string
  treatment: VatTreatment
}

/**
 * Get available VAT rates for invoice line items based on customer type.
 *
 * Swedish/EU-unvalidated customers can choose between 25%, 12%, 6%, and 0% (exempt).
 * Reverse charge and export customers are locked to 0%.
 *
 * This helper does NOT gate on the seller's VAT registration status: it only
 * knows the customer side. The seller-side gate lives one level up: the invoice
 * form hides the Moms column entirely when company_settings.vat_registered is
 * false, and both the create route and the MCP commit force every line to 0%
 * (momsfri) server-side, so a non-momsregistrerad company never books output VAT.
 */
export function getAvailableVatRates(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
): VatRateOption[] {
  // EU business with validated VAT → reverse charge, locked to 0%
  if (customerType === 'eu_business' && vatNumberValidated) {
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
 * - EU business with validated VAT: 0% reverse charge, moms ruta 39
 * - EU business without validated VAT: 25% VAT, moms ruta 05
 * - Non-EU business: 0% export, moms ruta 40
 *
 * Independent of the seller's VAT registration status. A non-momsregistrerad
 * seller who charges VAT still owes it under ML 16 kap. 23 § (faktureringsmoms),
 * so the rule output must reflect the rate actually charged on the line.
 */
export function getVatRules(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
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
      if (vatNumberValidated) {
        return {
          treatment: 'reverse_charge',
          rate: 0,
          momsRuta: '39',
          reverseChargeText: 'Omvänd skattskyldighet / Reverse charge - VAT to be accounted for by the recipient as per Article 196, Council Directive 2006/112/EC',
        }
      }
      // EU business without validated VAT number must be charged Swedish VAT
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
