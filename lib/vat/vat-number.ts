import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'

/**
 * Swedish VAT registration number (momsregistreringsnummer) helpers.
 *
 * Canonical format per Skatteverket: "SE" + 10-digit identity + "01" = SE
 * followed by exactly 12 digits, no spaces.
 *  - Aktiebolag: the 10-digit organisationsnummer, used as-is.
 *  - Enskild firma: the personnummer reduced to its 10-digit form (YYMMDD-NNNN).
 *    A 12-digit personnummer (YYYYMMDD-NNNN) has its birth-century prefix
 *    ('19'/'20') DROPPED first: including it would yield SE + 14 digits, which
 *    is invalid. This is the bug that shipped from the onboarding wizard.
 *
 * The "01" suffix is the registration serial; it is effectively always "01" for
 * a single registration.
 */

const SE_VAT_PATTERN = /^SE\d{12}$/

/**
 * Normalise raw user/provider input to the canonical spaceless, uppercase form.
 * Strips whitespace and hyphens (e.g. "se 556677-8899 01" → "SE556677889901").
 */
export function normalizeVatNumber(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

/** Structural validity check: literal "SE" followed by exactly 12 digits. */
export function isValidSwedishVatNumber(value: string): boolean {
  return SE_VAT_PATTERN.test(value)
}

/**
 * Derive a Swedish VAT number from an organisationsnummer or personnummer.
 *
 * Reuses {@link normalizeOrgNumber} to reach the canonical 10-digit identity
 * (century dropped for 12-digit personnummer, Luhn-validated), then appends the
 * "01" serial. Returns null when the input has no usable, structurally valid
 * 10/12-digit identity: callers should leave the VAT number blank rather than
 * persist a guess.
 */
export function deriveSwedishVatNumber(orgNumber: string | null | undefined): string | null {
  const canonical = normalizeOrgNumber(orgNumber)
  return canonical ? `SE${canonical}01` : null
}
