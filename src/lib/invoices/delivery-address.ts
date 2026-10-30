/**
 * Leveransadress per invoice (crm#1547): where the goods go when that is not
 * the customer's invoice address (billed to one party, delivered to another).
 *
 * Not a mandatory invoice field (ML 17 kap 24 § asks for the buyer's name and
 * address and the delivery date, not a delivery address); printed on the PDF
 * under "Leveransadress" and carried to Peppol as BG-13 Delivery information
 * (BT-70 deliver-to party name, BG-15 deliver-to address). Informational
 * only: the VAT treatment of goods sent abroad stays with delivery_country.
 *
 * Stored as one jsonb column, invoices.delivery_address (migration
 * 20261031109700). Pure: no client, no I/O, safe in client components.
 */
import { z } from 'zod'
import { isAssignedCountryCode, normalizeCountryCode } from '@/lib/vat/country-codes'

export interface InvoiceDeliveryAddress {
  name: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  /** ISO 3166-1 alpha-2; null = not stated (read as the customer's country). */
  country: string | null
}

const text = (max: number) => z.string().trim().max(max).nullish()

/**
 * The wire shape: every part optional, empty strings read as not set. A body
 * with nothing in it is no delivery address (null), so sending {} clears it
 * like null does.
 */
export const InvoiceDeliveryAddressSchema = z
  .object({
    name: text(200),
    address_line1: text(200),
    address_line2: text(200),
    postal_code: text(20),
    city: text(100),
    country: z
      .union([
        z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, 'delivery_address.country must be an ISO 3166-1 alpha-2 code')
          .transform((v) => normalizeCountryCode(v) as string)
          .refine(isAssignedCountryCode, 'delivery_address.country must be an assigned ISO 3166-1 alpha-2 country code'),
        z.literal(''),
      ])
      .nullish(),
  })
  .strict()
  .transform((value) => normalizeDeliveryAddress(value))

/** The stored form: trimmed parts, null for empty, null for an address with nothing in it. */
export function normalizeDeliveryAddress(raw: unknown): InvoiceDeliveryAddress | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const part = (key: keyof InvoiceDeliveryAddress): string | null => {
    const value = source[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }
  const address: InvoiceDeliveryAddress = {
    name: part('name'),
    address_line1: part('address_line1'),
    address_line2: part('address_line2'),
    postal_code: part('postal_code'),
    city: part('city'),
    country: part('country')?.toUpperCase() ?? null,
  }
  const hasContent = address.name || address.address_line1 || address.address_line2 || address.postal_code || address.city
  return hasContent ? address : null
}

/**
 * The lines the PDF prints under "Leveransadress": name, street lines,
 * "postnummer ort", and the country (by `countryName`) only when it differs
 * from the seller's.
 */
export function deliveryAddressLines(
  raw: unknown,
  homeCountry = 'SE',
  countryName: (code: string) => string = (code) => code,
): string[] {
  const address = normalizeDeliveryAddress(raw)
  if (!address) return []
  const place = [address.postal_code, address.city].filter(Boolean).join(' ')
  const country = address.country && address.country !== homeCountry.toUpperCase() ? countryName(address.country) : null
  return [address.name, address.address_line1, address.address_line2, place || null, country].filter(
    (line): line is string => !!line,
  )
}
