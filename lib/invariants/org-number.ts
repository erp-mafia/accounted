import { luhnValidate } from '@/lib/bankgiro/luhn'

/**
 * Swedish organisationsnummer / personnummer: the one place that decides what
 * "a valid org number" means.
 *
 * ## The rule
 *
 * - **Canonical storage form is 10 digits, no separators** (`5560125790`).
 * - Input may arrive as 10 or 12 digits, with spaces or hyphens, because that
 *   is what users type and what provider APIs return. Both forms normalize to
 *   the same 10 digits; the century prefix is dropped.
 * - The last digit is a Luhn (mod-10) check digit, the structural rule
 *   Bolagsverket and personnummer share.
 *
 * ## Why this module exists
 *
 * Before it, seven call sites each had their own idea of the rule, and four of
 * them fed Skatteverket-bound output that must agree:
 *
 * | Site | Old rule | Failure |
 * |---|---|---|
 * | `lib/skatteverket/format.ts` | strip `-` only | threw on any input containing a space |
 * | `lib/salary/ku/ku10-generator.ts` | `replace('-', '')` | first hyphen only, no space handling |
 * | `lib/salary/agi/xml-generator.ts` | strip non-digits | no check-digit validation |
 * | `lib/bokslut/ixbrl/validate/rules.ts` | `/^\d{6}-?\d{4}$/` | rejected the 12-digit form outright |
 *
 * A company stored with a space or in 12-digit form could file AGI all year and
 * then fail on the årsredovisning, with no way for the user to tell why. The
 * rules only stay in agreement if there is exactly one of them.
 *
 * ## Deliberate asymmetry: normalize everywhere, Luhn only at the boundary
 *
 * `normalizeOrgNumber` (Luhn-checked) guards data coming *in*. The export-time
 * converter `toRedovisare12` is structural only: it must not start rejecting
 * numbers that are already stored and have been filing successfully, because a
 * failed export at a deadline is worse than a number Skatteverket will reject
 * with its own message. Tighten the intake, not the outflow.
 */

/** Digits-only canonical storage length. */
export const ORG_NUMBER_LENGTH = 10

/**
 * Strip the separators Swedish users and provider APIs put in org numbers.
 * Does not validate: use {@link isOrgNumberShaped} or {@link normalizeOrgNumber}.
 */
export function stripOrgNumberFormatting(raw: string): string {
  return raw.replace(/[\s-]/g, '')
}

/**
 * True when the input is structurally an org number (10 or 12 digits after
 * separators are stripped), regardless of check digit.
 */
export function isOrgNumberShaped(raw: string | null | undefined): boolean {
  if (!raw) return false
  const cleaned = stripOrgNumberFormatting(raw)
  return /^\d{10}$/.test(cleaned) || /^\d{12}$/.test(cleaned)
}

/**
 * Normalize an org number to Accounted's canonical 10-digit storage form.
 *
 * Accepts hyphen/space-formatted input in either of the two shapes Swedish
 * users commonly type:
 *  - 10 digits (5560125790 or 8001011231): stored as-is
 *  - 12 digits (198001011231): century prefix stripped
 *
 * Returns null for any other length, non-digit content, or invalid Luhn check
 * digit. Storing a structurally invalid org number would later be caught by
 * Skatteverket SRU and any receiving SIE4 system: refusing at the boundary
 * keeps Accounted's bookkeeping from accumulating under an unusable identifier.
 */
export function normalizeOrgNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = stripOrgNumberFormatting(raw)
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

/** True when {@link normalizeOrgNumber} accepts the input. */
export function isValidOrgNumber(raw: string | null | undefined): boolean {
  return normalizeOrgNumber(raw) !== null
}

/**
 * True when the input is shaped like an org number but its check digit is
 * wrong. Lets a validator tell the user *which* problem they have instead of
 * one undifferentiated "ogiltigt organisationsnummer".
 */
export function hasInvalidOrgNumberCheckDigit(raw: string | null | undefined): boolean {
  return isOrgNumberShaped(raw) && !isValidOrgNumber(raw)
}

/**
 * Format a canonical org number for display: `NNNNNN-NNNN`.
 * Returns the input unchanged when it is not org-number shaped.
 */
export function formatOrgNumberDisplay(raw: string | null | undefined): string {
  if (!raw) return ''
  const cleaned = stripOrgNumberFormatting(raw)
  const ten = /^\d{12}$/.test(cleaned) ? cleaned.substring(2) : cleaned
  if (!/^\d{10}$/.test(ten)) return raw
  return `${ten.substring(0, 6)}-${ten.substring(6)}`
}

/**
 * Convert an org number to Skatteverket's 12-digit "redovisare" format.
 *
 * - Organisationsnummer (aktiebolag): prefix `16` (5020000013 -> 165020000013)
 * - Personnummer (enskild firma): prefix `19` or `20` by century
 * - Input already in 12-digit form passes through untouched
 *
 * Structural only, no check-digit validation: see the module docblock for why
 * the export path stays permissive.
 *
 * @throws when the input is not 10 or 12 digits after separators are stripped.
 */
export function toRedovisare12(
  orgNumber: string,
  entityType: 'enskild_firma' | 'aktiebolag',
): string {
  const clean = stripOrgNumberFormatting(orgNumber)

  if (/^\d{12}$/.test(clean)) return clean

  if (!/^\d{10}$/.test(clean)) {
    throw new Error(`Ogiltigt organisationsnummer: ${orgNumber} (förväntar 10 eller 12 siffror)`)
  }

  if (entityType === 'aktiebolag') return `16${clean}`

  // Enskild firma: personnummer. A two-digit year above the current one must
  // belong to the previous century (someone born in 98 is 1998, not 2098).
  const yearDigits = parseInt(clean.substring(0, 2), 10)
  const currentTwoDigitYear = new Date().getFullYear() % 100
  const prefix = yearDigits > currentTwoDigitYear ? '19' : '20'
  return `${prefix}${clean}`
}
