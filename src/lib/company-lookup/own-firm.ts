import type { SupabaseClient } from '@supabase/supabase-js'
import { hashPersonalNumber } from '@/lib/auth/bankid'
import { orgNumberKey, registrationNumberKey } from '@/lib/invariants/org-number'
import { usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { isLegalPersonOrgNumber } from '@/lib/parties/scb/org-number'
import { mapEntityType } from './entity-type-map'

/**
 * Whose firm is a sole trader's firm?
 *
 * An enskild firma's organisationsnummer IS the owner's personnummer, so the
 * one proof that such a firm belongs to the signed-in person is that number
 * being their own, BankID-verified personnummer. A name proves nothing: the
 * register holds many sole traders under the same name, and offering them by
 * name hands each one's personnummer and register data to whoever typed it,
 * and lets them set up books under another person's identity (crm#1456).
 *
 * Juridiska personer are not affected: their number identifies the company,
 * not a person, and anyone may look one up.
 *
 * Server-only: the comparison runs where the personnummer (or its hash) is
 * known, and the personnummer never travels to the client for it.
 */

/** True for a row that is a sole trader's firm: a person-shaped number or the form says so. */
function isSoleTrader(orgNumber: string | null | undefined, legalForm: string | null | undefined): boolean {
  const key = registrationNumberKey(orgNumber)
  if (key && !isLegalPersonOrgNumber(key)) return true
  const form = mapEntityType(legalForm)
  return !!form && usesPersonnummerAsOrgNumber(form)
}

/**
 * The signed-in user's BankID personnummer hash (bankid_identities, readable
 * by its owner under RLS), or null when the user has no proven BankID link:
 * none at all, or a signup whose address was never confirmed. A read error is
 * null too, so a failure offers fewer firms, never someone else's.
 */
export async function ownPersonalNumberHash(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('bankid_identities')
    .select('personal_number_hash, email_verified_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.email_verified_at) return null
  return typeof data.personal_number_hash === 'string' ? data.personal_number_hash : null
}

/**
 * True when a person-shaped org number (10, 12 or TIC's 16 digits) is the
 * personnummer behind `ownHash` (hashPersonalNumber of the 12-digit form
 * BankID returns). Both centuries are tried: the 10-digit key does not carry
 * one, and Accounted stores a sole trader's firm under those 10 digits.
 */
export function isOwnPersonalNumber(orgNumber: string | null | undefined, ownHash: string | null): boolean {
  if (!ownHash) return false
  const key = registrationNumberKey(orgNumber)
  if (!key) return false
  return hashPersonalNumber(`19${key}`) === ownHash || hashPersonalNumber(`20${key}`) === ownHash
}

/**
 * Register search hits a person may be offered: every juridisk person, and a
 * sole trader's firm only when it is their own (`ownHash`, see
 * ownPersonalNumberHash). Without a proven BankID link no sole trader is
 * offered by name; the owner types the org number (their personnummer).
 */
export function offerableSearchHits<T>(
  rows: readonly T[],
  describe: (row: T) => { orgNumber: string | null | undefined; legalForm: string | null | undefined },
  ownHash: string | null,
): T[] {
  return rows.filter((row) => {
    const { orgNumber, legalForm } = describe(row)
    return !isSoleTrader(orgNumber, legalForm) || isOwnPersonalNumber(orgNumber, ownHash)
  })
}

/**
 * The CompanyRoles a BankID identification may keep: every role in a
 * juridisk person (the roles TIC holds for this personnummer), and a sole
 * trader's firm only when its registration number is `personalNumber`
 * itself, the person's own firm. Called where the BankID personnummer is in
 * hand, before anything is stored.
 */
export function ownCompanyRoles<T extends { companyRegistrationNumber: string; legalEntityType?: string | null }>(
  roles: readonly T[],
  personalNumber: string,
): T[] {
  const own = orgNumberKey(personalNumber)
  return roles.filter((role) => {
    if (!isSoleTrader(role.companyRegistrationNumber, role.legalEntityType)) return true
    return !!own && registrationNumberKey(role.companyRegistrationNumber) === own
  })
}
