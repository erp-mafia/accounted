import { luhnValidate } from '@/lib/bankgiro/luhn'

/**
 * Normalize an org number to Accounted's canonical 10-digit storage form.
 *
 * Accepts hyphen/space-formatted input in either of the two shapes Swedish
 * users commonly type:
 *  - 10 digits (5560125790 or 8001011231): stored as-is
 *  - 12 digits (198001011231): century prefix stripped
 *
 * Returns null for any other length, non-digit content, or invalid Luhn
 * check digit (the structural rule Bolagsverket and personnummer share).
 * Storing a structurally invalid org number would later be caught by
 * Skatteverket SRU and any receiving SIE4 system: refusing at the boundary
 * keeps Accounted's bookkeeping from accumulating under an unusable identifier.
 *
 * 10-digit storage matches the rest of the codebase: see
 * `lib/skatteverket/format.ts`, which converts 10→12 at export time by
 * prefixing with '16' (AB) or '19'/'20' (EF personnummer).
 */
export function normalizeOrgNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/[\s-]/g, '')
  let canonical: string
  if (/^\d{10}$/.test(cleaned)) {
    canonical = cleaned
  } else if (/^\d{12}$/.test(cleaned)) {
    canonical = cleaned.substring(2)
  } else {
    return null
  }
  return luhnValidate(canonical) ? canonical : null
}
