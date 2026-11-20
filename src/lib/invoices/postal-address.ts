/**
 * A postal address as the invoice and the app print it, in the convention of
 * the address's country:
 *
 *   - Sweden and most of Europe: "postnummer ort" (111 22 Stockholm);
 *   - the United States and Canada: "City, ST ZIP" (Bellevue, WA 98006),
 *     with the state or province (customers.address_state).
 *
 * The one place that knows the order: the invoice PDF (seller, buyer and
 * delivery address), the customer card, the invoice page and the editors read
 * it, and the customer form asks for a state only where addressHasState says
 * the country has one. Pure: no client, no I/O, safe in client components.
 */
import { normalizeCountryCode } from '@/lib/vat/country-codes'

export interface PostalAddress {
  address_line1?: string | null
  address_line2?: string | null
  postal_code?: string | null
  city?: string | null
  /** State or province (customers.address_state). */
  address_state?: string | null
  /** ISO 3166-1 alpha-2; a legacy name is read through normalizeCountryCode. */
  country?: string | null
}

/** The countries whose addresses name a state or province, written "City, ST ZIP". */
const CITY_STATE_ZIP_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA'])

/** Whether an address in this country carries a state or province (the customer form shows the field). */
export function addressHasState(country: string | null | undefined): boolean {
  const code = normalizeCountryCode(country)
  return code !== null && CITY_STATE_ZIP_COUNTRIES.has(code)
}

function part(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * The line with the postal code and the town, or null when the address has
 * neither. A state on an address outside the US and Canada (only the API can
 * set one) follows the town.
 */
export function postalPlaceLine(address: PostalAddress): string | null {
  const postalCode = part(address.postal_code)
  const city = part(address.city)
  const state = part(address.address_state)
  if (addressHasState(address.country)) {
    const stateAndZip = [state, postalCode].filter(Boolean).join(' ')
    if (city && state) return `${city}, ${stateAndZip}`
    return [city, stateAndZip].filter(Boolean).join(' ') || null
  }
  return [postalCode, city, state].filter(Boolean).join(' ') || null
}

/**
 * The address block's lines: the street lines, the place line, then
 * `countryLine` when the caller prints one (whether the country is printed,
 * and in which language, is the caller's rule).
 */
export function formatPostalAddress(address: PostalAddress, countryLine: string | null = null): string[] {
  return [part(address.address_line1), part(address.address_line2), postalPlaceLine(address), part(countryLine)].filter(
    (line): line is string => line !== null,
  )
}
