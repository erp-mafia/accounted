import { calculateAge, expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'
import { looksLikeSwedishPersonalNumber } from '@/lib/customers/personal-number-shape'

/**
 * A debtor's personal identity number on its way to the collections
 * provider: normalized to the twelve digits the contract carries, checked,
 * aged, and kept out of everything the ledger stores.
 *
 * Pure: the reveal itself (decrypting customers.personal_number) happens in
 * the open-case service, which logs who revealed which customer and why,
 * never the number. Never falls back to a ROT/RUT deduction personnummer
 * (invoices.deduction_personnummer_encrypted): it may belong to another
 * buyer, or to two.
 *
 * Founder decision 2026-10-04 (the provider's answer): a private customer
 * WITHOUT a personnummer is handed over with name and full postal address,
 * and the provider finds the person; a missing number is a hint, never a
 * block. An invalid one is not sent either, and is shown so it can be fixed.
 */

export type DebtorPersonalNumber =
  | { status: 'none' }
  /** Stored but not a valid personnummer or samordningsnummer, or unreadable: not sent. */
  | { status: 'invalid' }
  | { status: 'valid'; digits: string; age: number }

/**
 * Normalize a plaintext personnummer as the customer card stores it
 * (`^(\d{6}|\d{8})[-+]?\d{4}$`) to twelve digits: 8+4 as is; 6+4 takes the
 * century that makes the person at most 99 years old at `now`, and with `+`
 * the century before that (100 or older). The Luhn digit is checked on the
 * last ten digits and the date must exist; a samordningsnummer (day 61 to
 * 91) is accepted and aged from its real day. `today` is the calendar date
 * the age is taken on (YYYY-MM-DD).
 */
export function normalizeDebtorPersonalNumber(
  plaintext: string | null | undefined,
  now: Date,
  today: string,
): DebtorPersonalNumber {
  const value = plaintext?.trim()
  if (!value) return { status: 'none' }
  if (!/^(\d{6}|\d{8})[-+]?\d{4}$/.test(value)) return { status: 'invalid' }
  const digits = expandPersonnummerTo12(value, now)
  if (!digits || !validatePersonnummer(digits).valid || !isRealDate(digits)) return { status: 'invalid' }
  const age = calculateAge(digits, today)
  if (age < 0) return { status: 'invalid' }
  return { status: 'valid', digits, age }
}

function isRealDate(digits: string): boolean {
  const year = Number(digits.slice(0, 4))
  const month = Number(digits.slice(4, 6))
  const printedDay = Number(digits.slice(6, 8))
  const day = printedDay > 60 ? printedDay - 60 : printedDay
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** The age from which a person can be pursued for a debt through this flow. */
export const ADULT_AGE = 18

const PERSONAL_NUMBER_CANDIDATE_RE = /(?<!\d)(?:\d{6}|\d{8})[-+ ]?\d{4}(?!\d)/g
export const PERSONAL_NUMBER_PLACEHOLDER = '[personnummer]'

/**
 * Replace anything shaped like a Swedish personal identity number (10 or 12
 * digits, optional separator, a real month and day) in free text. Org
 * numbers (month 20 or higher) are left alone. Applied to every label and
 * raw payload the ledger stores from the provider: Connect allowlists what
 * it returns, and this is the ledger's own second line.
 */
export function stripPersonalNumbers(text: string): string {
  return text.replace(PERSONAL_NUMBER_CANDIDATE_RE, (match) =>
    looksLikeSwedishPersonalNumber(match) ? PERSONAL_NUMBER_PLACEHOLDER : match,
  )
}

/** stripPersonalNumbers over every string, and every whole number, in a JSON value. */
export function stripPersonalNumbersDeep<T>(value: T): T {
  if (typeof value === 'string') return stripPersonalNumbers(value) as T
  // A personnummer sent as a JSON number (ten or twelve digits) is still one.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    const digits = String(value)
    return (stripPersonalNumbers(digits) === digits ? value : PERSONAL_NUMBER_PLACEHOLDER) as T
  }
  if (Array.isArray(value)) return value.map((v) => stripPersonalNumbersDeep(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripPersonalNumbersDeep(v)
    return out as T
  }
  return value
}
