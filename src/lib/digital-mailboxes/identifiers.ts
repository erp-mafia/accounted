/**
 * The identifiers Kivra and Billo address companies and people by.
 *
 * Both name a Swedish company by its VAT-number shape, `SE` + the ten-digit
 * organisationsnummer + `01`, even in fields called `orgnr`; Billo's partner
 * and mailbox APIs take the plain organisationsnummer. People are always the
 * twelve-digit personnummer (YYYYMMDDNNNN).
 */
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'
import type { PayslipEmployer } from './types'

const VAT_NUMBER_RE = /^SE(\d{10})01$/

/** `SE442005920801` for an organisationsnummer in any common shape; null when it is not one. */
export function swedishVatNumber(orgNumber: string | null | undefined): string | null {
  const ten = normalizeOrgNumber(orgNumber)
  return ten ? `SE${ten}01` : null
}

/** The ten-digit organisationsnummer inside a Swedish VAT number, or null. */
export function orgNumberFromVatNumber(vatNumber: string | null | undefined): string | null {
  const match = VAT_NUMBER_RE.exec((vatNumber ?? '').replace(/\s/g, '').toUpperCase())
  return match ? match[1]! : null
}

/**
 * Whether the organisationsnummer belongs to a legal person (aktiebolag,
 * handelsbolag, förening): its third digit is 2 or higher. An enskild firma
 * is its owner's personnummer, whose third digit is a month's first digit
 * (0 or 1); neither Kivra Företag nor Billo's business mailbox takes one.
 */
export function isLegalPersonOrgNumber(orgNumber: string | null | undefined): boolean {
  const ten = normalizeOrgNumber(orgNumber)
  return !!ten && Number(ten[2]) >= 2
}

/** The twelve-digit personnummer, or null when the value is not a valid one. */
export function personnummer12(value: string | null | undefined): string | null {
  if (!value) return null
  const twelve = expandPersonnummerTo12(value)
  if (!twelve) return null
  return validatePersonnummer(twelve).valid ? twelve : null
}

export interface PayslipEmployerContact {
  streetAddress: string
  postalCode: string
  city: string
  email: string
  /** Digits, national form for a Swedish number (0846500405), E.164 otherwise. */
  phone: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The employer's address, email and phone as a payslip carries them, or
 * null while any of them is missing or not usable. The phone goes in national
 * form: Kivra's telephone pattern takes a number that starts with a digit
 * however its `+` branch is read.
 */
export function payslipEmployerContact(employer: PayslipEmployer): PayslipEmployerContact | null {
  const streetAddress = employer.streetAddress?.trim()
  const postalCode = employer.postalCode?.trim()
  const city = employer.city?.trim()
  const email = employer.email?.trim()
  const e164 = phoneToE164(employer.phone)
  if (!streetAddress || !postalCode || !city || !email || !EMAIL_RE.test(email) || !e164) return null
  return { streetAddress, postalCode, city, email, phone: e164.startsWith('+46') ? `0${e164.slice(3)}` : e164 }
}

/** A Swedish mobile number as E.164 (+46...), or null when it is not one Billo accepts. */
export function phoneToE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  let digits = trimmed.replace(/\D/g, '')
  if (!digits) return null
  if (trimmed.startsWith('+')) digits = `+${digits}`
  else if (digits.startsWith('00')) digits = `+${digits.slice(2)}`
  else if (digits.startsWith('0')) digits = `+46${digits.slice(1)}`
  else if (digits.startsWith('46')) digits = `+${digits}`
  else return null
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null
}
