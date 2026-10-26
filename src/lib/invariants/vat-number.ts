/**
 * EU VAT numbers: the national part each member state's number has, by its
 * VIES prefix (Greece is EL), and whether a value read off a document is one.
 *
 * One table for the VIES pre-check (lib/vat/vies-client.ts) and for the
 * readers that take a seller's VAT number and country off a document
 * (lib/vat/seller-country.ts, lib/documents/reading/assemble.ts, the inbox
 * extraction). A Swedish VAT number is SE followed by twelve digits, the
 * organisationsnummer and 01 (ML 17 kap. 24 § p. 3; Peppol SE-R-001).
 */
export const VAT_FORMAT_PATTERNS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^0\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^[0-9A-Z]{8,9}$/,
  IT: /^\d{11}$/,
  LT: /^\d{9,12}$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
}

/**
 * Letters and digits only, upper case, with a prefix printed twice written
 * once: "SE 5560-1257 9001" and "SESE556012579001" are "SE556012579001".
 */
export function compactVatNumber(value: string): string {
  const compact = value.replace(/[\s.\-]/g, '').toUpperCase()
  return compact.replace(/^([A-Z]{2})\1(?=\d)/, '$1')
}

/**
 * True when the value starts with an EU member state's prefix but what
 * follows is not that state's VAT number (crm#1411): "SESL000D" is a
 * supplier's internal VAT-code label printed beside its tax line, and
 * "SE5566778899" an organisationsnummer with SE in front. Such a value names
 * no VAT registration and no country, so a reader neither shows it as the
 * seller's VAT number nor takes the seller's country from it. A prefix with
 * no format here (XI, a state outside the EU) is not judged.
 */
export function isMalformedEuVatNumber(value: string | null | undefined): boolean {
  if (!value) return false
  const compact = compactVatNumber(value)
  const prefix = compact.slice(0, 2)
  const pattern = VAT_FORMAT_PATTERNS[prefix === 'GR' ? 'EL' : prefix]
  if (!pattern) return false
  return !pattern.test(compact.slice(2))
}
