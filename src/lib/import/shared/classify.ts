import type { CustomerType, SupplierType } from '@/types'

/**
 * EU VAT number prefixes (excluding SE).
 * Source: https://taxation-ec.europa.eu/online-services/check-vat-number-vies_en
 */
export const EU_VAT_PREFIXES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES',
  'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SI', 'SK', 'XI', // XI = Northern Ireland
])

/**
 * Strip whitespace, dashes, and dots from an org/personnummer for length checks.
 */
function digits(value: string | null): string {
  if (!value) return ''
  return value.replace(/\D/g, '')
}

/**
 * Check the third digit of a Swedish org/personnummer.
 *
 * Personnummer: month digit (00-12): third digit ≤ 1.
 * Företag: third digit ≥ 2 (per Skatteverket's allocation rules).
 */
function looksLikePersonnummer(orgNumber: string | null): boolean {
  const d = digits(orgNumber)
  // 12 digits = full personnummer (YYYYMMDDXXXX)
  if (d.length === 12) return true
  // 10 digits: disambiguate by month (positions 3-4 are month, 01-12)
  if (d.length === 10) {
    const month = parseInt(d.substring(2, 4), 10)
    if (month >= 1 && month <= 12 && d[2] <= '1') return true
  }
  return false
}

function vatPrefix(vatNumber: string | null): string | null {
  if (!vatNumber) return null
  const cleaned = vatNumber.trim().toUpperCase()
  const match = cleaned.match(/^([A-Z]{2})/)
  return match ? match[1] : null
}

/**
 * Auto-classify a customer based on org_number + vat_number heuristics.
 *
 * Precedence:
 *   1. Non-SE EU VAT prefix → 'eu_business'
 *   2. Non-EU letter prefix → 'non_eu_business'
 *   3. Personnummer-shaped org → 'individual'
 *   4. Default → 'swedish_business'
 */
export function classifyCustomer(args: {
  org_number: string | null
  vat_number: string | null
  country?: string | null
}): CustomerType {
  const prefix = vatPrefix(args.vat_number)
  if (prefix && prefix !== 'SE') {
    if (EU_VAT_PREFIXES.has(prefix)) return 'eu_business'
    return 'non_eu_business'
  }

  const country = args.country?.trim().toUpperCase()
  if (country && country !== 'SE' && country !== 'SVERIGE' && country !== 'SWEDEN') {
    // Country-based fallback when VAT is missing.
    if (country.length === 2 && EU_VAT_PREFIXES.has(country)) return 'eu_business'
    if (country.length >= 3) {
      // Common Swedish names for non-EU jurisdictions; heuristic is best-effort
      if (/norge|norway|usa|kanada|canada|storbritannien|uk|united kingdom/i.test(country)) {
        return 'non_eu_business'
      }
    }
  }

  if (looksLikePersonnummer(args.org_number)) return 'individual'
  return 'swedish_business'
}

/**
 * Auto-classify a supplier. Suppliers cannot be 'individual': Swedish business
 * with personnummer is still 'swedish_business' (a sole trader supplier).
 */
export function classifySupplier(args: {
  org_number: string | null
  vat_number: string | null
  country?: string | null
}): SupplierType {
  const prefix = vatPrefix(args.vat_number)
  if (prefix && prefix !== 'SE') {
    if (EU_VAT_PREFIXES.has(prefix)) return 'eu_business'
    return 'non_eu_business'
  }

  const country = args.country?.trim().toUpperCase()
  if (country && country !== 'SE' && country !== 'SVERIGE' && country !== 'SWEDEN') {
    if (country.length === 2 && EU_VAT_PREFIXES.has(country)) return 'eu_business'
    if (/norge|norway|usa|kanada|canada|storbritannien|uk|united kingdom/i.test(country)) {
      return 'non_eu_business'
    }
  }

  return 'swedish_business'
}
