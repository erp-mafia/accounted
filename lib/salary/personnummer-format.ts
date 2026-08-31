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

  // Luhn check on digits 3-12 (YYMMDDNNNN, 10 digits)
  const luhnDigits = digits.slice(2)
  if (!luhnCheck(luhnDigits)) {
    return { valid: false, error: 'Ogiltigt kontrollnummer (Luhn)' }
  }

  return { valid: true }
}

/**
 * Luhn checksum validation for 10-digit string.
 */
function luhnCheck(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = parseInt(digits[i])
    // Multiply every other digit by 2, starting from the first
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
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

/**
 * Mask personnummer for display: YYYYMMDD-XXXX (birthdate visible, suffix hidden).
 */
export function maskPersonnummer(personnummer: string): string {
  const digits = personnummer.replace(/\D/g, '')
  return `${digits.slice(0, 8)}-XXXX`
}

/**
 * Format personnummer with dash: YYYYMMDD-NNNN
 */
export function formatPersonnummer(personnummer: string): string {
  const digits = personnummer.replace(/\D/g, '')
  return `${digits.slice(0, 8)}-${digits.slice(8)}`
}

/**
 * Expand a personnummer to the 12-digit form (YYYYMMDDNNNN).
 *
 * Accepts the shapes the customer card stores (10 or 12 digits, optional -/+
 * separator; see PERSONAL_NUMBER_INPUT_RE in lib/customers). A 10-digit value
 * gets its century inferred the standard Skatteverket way: the most recent
 * birth date not after `now`, minus a further hundred years when the
 * separator is '+' (the over-100 marker). Samordningsnummer day offsets
 * (+60) are stripped for the calendar comparison only; the returned digits
 * keep the printed day. Returns digits only, or null when the input has
 * neither shape. No checksum validation here: callers that need it run the
 * result through validatePersonnummer.
 */
export function expandPersonnummerTo12(value: string, now: Date = new Date()): string | null {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 12) return digits
  if (digits.length !== 10) return null

  const yy = parseInt(digits.slice(0, 2), 10)
  const month = parseInt(digits.slice(2, 4), 10)
  const day = parseInt(digits.slice(4, 6), 10)
  const birthDay = day > 60 ? day - 60 : day

  // Compare dates as yyyymmdd integers: immune to Date rollover on the
  // not-yet-validated month/day values.
  const today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
  let year = Math.floor(now.getFullYear() / 100) * 100 + yy
  if (year * 10000 + month * 100 + birthDay > today) year -= 100
  if (trimmed.includes('+')) year -= 100
  return `${year}${digits.slice(2)}`
}
