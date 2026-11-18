/**
 * Personnummer parsing, validation and formatting. Pure string/date logic,
 * no Node imports: lib/salary/personnummer.ts (which also encrypts with
 * `crypto`) re-exports everything here for its server callers, while
 * client components reach these through lib/salary/tax-column.ts without
 * the browser crypto polyfill.
 */

/**
 * Extract the last 4 digits of a personnummer for display.
 */
import { luhnValidate } from '@/lib/bankgiro/luhn'

export function extractLast4(personnummer: string): string {
  const digits = personnummer.replace(/\D/g, '')
  return digits.slice(-4)
}

/**
 * Validate a Swedish personnummer or samordningsnummer (12-digit format:
 * YYYYMMDDNNNN). Checks format + Luhn checksum on last 10 digits.
 *
 * A samordningsnummer is the identity number Skatteverket assigns to a person
 * who has no personnummer. It has the same shape, except the day field carries
 * an added 60, so the printed day is 61-91 instead of 1-31. Skatteverket files
 * these under FK215 in the arbetsgivardeklaration exactly like a personnummer,
 * and our own AGI generator accepts them (see IDENTITET_PATTERN in
 * lib/salary/agi/xml-generator.ts, which spells out "samordningsnummer where
 * day = actual_day + 60"). Rejecting them here meant the system could file an
 * AGI for someone it refused to register as an employee.
 *
 * The Luhn check digit is computed over the printed digits, the +60 day
 * included: a samordningsnummer has no underlying non-offset form to compute it
 * from. So the checksum below is deliberately untouched by the offset.
 */
export function validatePersonnummer(personnummer: string): { valid: boolean; error?: string } {
  const digits = personnummer.replace(/\D/g, '')

  if (digits.length !== 12) {
    return { valid: false, error: 'Personnummer måste vara 12 siffror (ÅÅÅÅMMDDNNNN)' }
  }

  const year = parseInt(digits.slice(0, 4))
  const month = parseInt(digits.slice(4, 6))
  const day = parseInt(digits.slice(6, 8))

  if (year < 1900 || year > 2100) {
    return { valid: false, error: 'Ogiltigt år' }
  }
  if (month < 1 || month > 12) {
    return { valid: false, error: 'Ogiltig månad' }
  }
  // Strip the samordningsnummer offset before range-checking the day, so both
  // forms collapse to a real 1-31 calendar day. This accepts 1-31 (personnummer)
  // and 61-91 (samordningsnummer) while still rejecting 32-60 and 92-99, which
  // are neither: 32-60 is an out-of-range day that has not been offset, and
  // 92-99 offsets back to day 32-39.
  const birthDay = day > 60 ? day - 60 : day
  if (birthDay < 1 || birthDay > 31) {
    return { valid: false, error: 'Ogiltig dag' }
  }

  // Luhn check on digits 3-12 (YYMMDDNNNN, 10 digits). The message names the
  // personnummer itself: it is often refused in the same call as a bank
  // account, whose kontonummer has check digits of its own.
  const luhnDigits = digits.slice(2)
  if (!luhnValidate(luhnDigits)) {
    return { valid: false, error: 'Personnumrets kontrollsiffra stämmer inte. Kontrollera alla 12 siffror.' }
  }

  return { valid: true }
}

/**
 * Extract birth date from a 12-digit personnummer or samordningsnummer.
 *
 * A samordningsnummer prints the day offset by 60 (61-91). The offset is a
 * numbering convention, not a calendar fact, so the returned `day` is always
 * the real 1-31 calendar day: consumers doing date math (calculateAge's
 * birthday comparison, or anything constructing a Date) would otherwise be
 * off by 60 days. The Luhn checksum is computed over the printed, offset
 * digits and is untouched by this normalization (see validatePersonnummer).
 */
export function extractBirthDate(personnummer: string): { year: number; month: number; day: number } {
  const digits = personnummer.replace(/\D/g, '')
  const printedDay = parseInt(digits.slice(6, 8))
  return {
    year: parseInt(digits.slice(0, 4)),
    month: parseInt(digits.slice(4, 6)),
    day: printedDay > 60 ? printedDay - 60 : printedDay,
  }
}

/**
 * Calculate age at a given date from a personnummer.
 */
export function calculateAge(personnummer: string, atDate: string): number {
  const birth = extractBirthDate(personnummer)
  const [refYear, refMonth, refDay] = atDate.split('-').map(Number)

  let age = refYear - birth.year
  if (refMonth < birth.month || (refMonth === birth.month && refDay < birth.day)) {
    age--
  }
  return age
}

/**
 * Age tier for "vid årets ingång fyllt X" rules (avgifter age tiers).
 *
 * Skatteverket applies these rules as BIRTH-YEAR ranges (the 2026
 * ungdomsrabatt covers born 2003-2007; the 66/67+ reduction for 2026 covers
 * born 1958 or earlier), which equals the age attained by December 31 of
 * the PRIOR year. Birthday-inclusive age at January 1 (calculateAge
 * semantics) misclassifies employees born exactly on January 1 in both
 * directions: born 2008-01-01 would get the 2026 youth rate (Skatteverket's
 * AGI validation rejects it) and born 2003-01-01 would be denied it.
 */
export function calculateAgeAtYearStart(personnummer: string, year: number): number {
  return year - 1 - extractBirthDate(personnummer).year
}

/** What a value that is not a 10- or 12-digit number masks to: nothing shown. */
export const REDACTED_PERSONNUMMER = 'XXXXXXXX-XXXX'

/**
 * The one display form of a natural person's personnummer on every read
 * surface (the payroll pages, payslips, ROT/RUT, v1, MCP): the birth date
 * visible, the last four digits (sex and check digit) hidden, in the written
 * form Skatteverket uses. YYYYMMDD-XXXX for the 12-digit form, YYMMDD-XXXX
 * for the 10-digit form (an enskild firma's organisation number). Anything
 * else is redacted whole: slicing an unexpected length would show digits of
 * the serial number.
 */
export function maskPersonnummer(personnummer: string | null | undefined): string {
  const digits = (personnummer ?? '').replace(/\D/g, '')
  if (digits.length === 12) return `${digits.slice(0, 8)}-XXXX`
  if (digits.length === 10) return `${digits.slice(0, 6)}-XXXX`
  return REDACTED_PERSONNUMMER
}

/** Month 01-12 and day 01-31, or 61-91 for a samordningsnummer (day + 60). */
const MMDD = '(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01]|6[1-9]|[78]\\d|9[01])'

/**
 * A 12-digit personnummer or samordningsnummer in free text: YYYYMMDDNNNN,
 * or with "-", "+" or a space before the last four digits. The date part
 * must look like a birth date (year 18xx-20xx), so an employer id such as
 * 16XXXXXXXXXX, an amount or a reference number is left alone.
 */
const PERSONNUMMER_12_IN_TEXT = new RegExp(`(?<!\\d)((?:18|19|20)\\d{2}${MMDD})[-+ ]?\\d{4}(?!\\d)`, 'g')

/**
 * The 10-digit form, YYMMDDNNNN or YYMMDD-NNNN / YYMMDD+NNNN. An
 * organisationsnummer has the same shape but its third digit is 2 or more
 * (NN2N...), which no month can be, so the month check leaves it alone.
 */
const PERSONNUMMER_10_IN_TEXT = new RegExp(`(?<![\\d-])(\\d{2}${MMDD})[-+]?\\d{4}(?![\\d-])`, 'g')

/**
 * Mask every personnummer in a free-text message, keeping the birth date
 * the way maskPersonnummer does: YYYYMMDD-XXXX for the 12-digit form,
 * YYMMDD-XXXX for the 10-digit form. For third-party text that can name an
 * employee by personnummer (e.g. Skatteverket's AGI kontrollsvar) before it
 * reaches an API caller or an agent's context.
 */
export function maskPersonnummerInText(text: string): string {
  return text
    .replace(PERSONNUMMER_12_IN_TEXT, '$1-XXXX')
    .replace(PERSONNUMMER_10_IN_TEXT, '$1-XXXX')
}

/**
 * Format personnummer with dash: YYYYMMDD-NNNN
 */
export function formatPersonnummer(personnummer: string): string {
  const digits = personnummer.replace(/\D/g, '')
  return `${digits.slice(0, 8)}-${digits.slice(8)}`
}

export { expandPersonnummerTo12 } from '@/lib/invariants/personal-number-shape'
