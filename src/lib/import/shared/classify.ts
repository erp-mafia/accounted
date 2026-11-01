import { swedishNumberKind } from '@/lib/invariants/org-number'
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

  if (swedishNumberKind(args.org_number) === 'person') return 'individual'
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
