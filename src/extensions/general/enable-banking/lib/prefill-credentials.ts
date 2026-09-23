import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import type { AuthMethod, AuthMethodCredential } from './api-client'

/**
 * Credentials we can fill in for the PSU before Enable Banking's hosted page
 * asks for them.
 *
 * Handelsbanken (business) asks for "Företags-ID" on that page: the
 * organisationsnummer as 10 digits, no hyphen, and the page shows no format
 * hint and rejects "556809-8239". The company's org number is already in
 * the ledger, so it is sent prefilled (autosubmit is off). The signer's
 * personnummer is never known here and is left to the person.
 *
 * A prefilled value is shown locked on the hosted page: the person cannot
 * correct it, and Enable Banking documents no way to prefill a field and
 * keep it editable. A wrong prefill therefore blocks the connection, while
 * no prefill only asks the person to type. So a value is sent only when we
 * know the form the bank wants.
 *
 * A sole trader's identifier is the owner's personnummer, and banks disagree
 * on its length: Handelsbanken's template is `^\d{10}$` (YYMMDDXXXX), while
 * Nordea's page asks for "10 digit organisation number (or 12 digit personal
 * number if the company is a sole proprietorship)". For a sole trader the
 * 12-digit form (YYYYMMDDXXXX) is sent when the method's template accepts
 * it, the 10-digit form when only that matches, and nothing when the method
 * declares no usable template (the length the bank wants is then unknown).
 *
 * Generic on the declared credential, not the bank: any method declaring a
 * `companyId` credential gets the value, and only when it matches the
 * method's own template, so a value the page would reject is never sent.
 */

/** The credential name Enable Banking uses for the company identifier. */
const COMPANY_ID_CREDENTIAL = 'companyId'

export interface PrefillCompany {
  org_number: string | null
  entity_type: string | null
}

/**
 * Whether the stored org number is the owner's personnummer (an enskild
 * firma). An unknown or missing form is treated as not, so it never gets the
 * personnummer handling.
 */
function orgIdIsPersonnummer(company: PrefillCompany): boolean {
  return isEntityType(company.entity_type) && usesPersonnummerAsOrgNumber(company.entity_type)
}

/**
 * The 10-digit identifier: the organisationsnummer for a company, the
 * personnummer without century (YYMMDDXXXX) for a sole trader. Null when the
 * stored number does not reduce to 10 digits.
 */
export function companyIdDigits(company: PrefillCompany): string | null {
  const digits = (company.org_number ?? '').replace(/\D/g, '')
  if (digits.length === 10) return digits
  // A sole trader's personnummer may be stored with the century
  // (YYYYMMDDXXXX); drop it for the 10-digit form.
  if (digits.length === 12 && orgIdIsPersonnummer(company) && /^(19|20)/.test(digits)) {
    return digits.slice(2)
  }
  return null
}

/**
 * A sole trader's personnummer with century (YYYYMMDDXXXX). Null for any
 * other entity type or a number that is not a personnummer.
 *
 * Stored as 12 digits starting 19 or 20: used as is. Stored as 10 digits:
 * the century is derived the way the personnummer is written, the most
 * recent year ending in YY that is not in the future, and a "+" separator
 * (used from the year the person turns 100) moves it one century back.
 */
export function soleTraderPersonnummer12(company: PrefillCompany, now: Date = new Date()): string | null {
  if (!orgIdIsPersonnummer(company)) return null
  const raw = company.org_number ?? ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 12) return /^(19|20)/.test(digits) ? digits : null
  if (digits.length !== 10) return null
  const currentYear = now.getFullYear()
  const yy = Number(digits.slice(0, 2))
  let birthYear = currentYear - ((((currentYear % 100) - yy) % 100) + 100) % 100
  if (raw.includes('+')) birthYear -= 100
  const century = Math.floor(birthYear / 100)
  if (century !== 19 && century !== 20) return null
  return `${century}${digits}`
}

/** Whether the method asks the PSU for a company identifier at all. */
export function wantsCompanyId(method: AuthMethod | undefined): boolean {
  return !!method?.credentials?.some((c) => c.name === COMPANY_ID_CREDENTIAL)
}

/**
 * Whether the credential's template accepts the value. Null when there is
 * no template or it cannot be parsed: the page validates on its own, but we
 * cannot tell which form it wants.
 */
function templateAccepts(credential: AuthMethodCredential, value: string): boolean | null {
  if (!credential.template) return null
  try {
    return new RegExp(credential.template).test(value)
  } catch {
    return null
  }
}

/**
 * The credentials to send on POST /auth, or undefined when there is nothing
 * to prefill (no method metadata, no companyId credential, no usable number,
 * or, for a sole trader, no template telling which length the bank wants).
 */
export function buildPrefilledCredentials(
  method: AuthMethod | undefined,
  company: PrefillCompany,
  now: Date = new Date(),
): Record<string, string> | undefined {
  const credential = method?.credentials?.find((c) => c.name === COMPANY_ID_CREDENTIAL)
  if (!credential) return undefined

  if (orgIdIsPersonnummer(company)) {
    // Longest form first: a template that accepts the 12-digit form belongs
    // to a bank that takes the full personnummer for a sole trader.
    const candidates = [soleTraderPersonnummer12(company, now), companyIdDigits(company)]
    for (const value of candidates) {
      if (value && templateAccepts(credential, value) === true) {
        return { [COMPANY_ID_CREDENTIAL]: value }
      }
    }
    return undefined
  }

  const value = companyIdDigits(company)
  // An organisationsnummer has one form, 10 digits, so a missing or
  // unparsable template is no reason to withhold it.
  if (!value || templateAccepts(credential, value) === false) return undefined
  return { [COMPANY_ID_CREDENTIAL]: value }
}
