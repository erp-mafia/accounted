/**
 * Validation for the moderföretag identifier in the årsredovisning note
 * (ÅRL 5 kap. 21 §: namn, organisationsnummer/motsvarande och säte).
 *
 * Two shapes are accepted:
 *
 *  1. Swedish organisationsnummer, NNNNNN-NNNN or the 12-digit 16NNNNNNNNNN
 *     form, dash optional. The third digit must be 2-9: that is what separates
 *     legal-entity numbers from personnummer (whose third digit is part of a
 *     month, 0-1). Personnummer are out of scope for the disclosure and a GDPR
 *     Art. 5(1)(c) data-minimisation concern if persisted, so both the 10-digit
 *     and the century-prefixed 12-digit personnummer shapes are rejected.
 *  2. A foreign registration identifier as written in the home register:
 *     CHE-123.456.789 (Switzerland), 923 609 016 (Norway), HRB 12345
 *     (Germany), 1234567-8 (Finland), 12345678 (UK CRN, DK CVR) and so on.
 *     Letters, digits, space, dot, comma, dash and slash, 2-40 characters.
 *     A foreign 10- or 12-digit all-numeric value is treated as Swedish-shaped
 *     and falls under rule 1; that false negative is accepted in exchange for
 *     never storing a personnummer.
 */

const FOREIGN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9 .,\-/]{1,39}$/

export function isValidParentCompanyIdentifier(raw: string): boolean {
  const value = raw.trim()
  if (!value) return false

  const digitsOnly = value.replace(/[\s-]/g, '')
  const allDigits = /^\d+$/.test(digitsOnly)
  if (allDigits && (digitsOnly.length === 10 || digitsOnly.length === 12)) {
    if (digitsOnly.length === 12 && !digitsOnly.startsWith('16')) return false
    const core = digitsOnly.length === 12 ? digitsOnly.slice(2) : digitsOnly
    return /^\d{2}[2-9]\d{7}$/.test(core)
  }

  return FOREIGN_IDENTIFIER.test(value)
}

export const PARENT_COMPANY_IDENTIFIER_ERROR =
  'Ogiltigt organisationsnummer (svenskt NNNNNN-NNNN, ej personnummer). Utländskt moderföretag: ange registreringsnumret som det står i hemlandets register, t.ex. CHE-123.456.789.'
