import type { SupabaseClient } from '@supabase/supabase-js'
import { orgNumberKey, registrationNumberKey } from '@/lib/invariants/org-number'
import { isCeasedCompanyStatus } from './engagements'

/**
 * Whether a person is a firmatecknare of an organisationsnummer, proven with
 * their own BankID.
 *
 * An org number in Accounted is typed into the company settings, not proven,
 * and any number may be typed. Where a company's number opens something that
 * belongs to the real company (its mail in a digital mailbox), the person
 * asking has to show they may act for it. The proof is the one a BankID login
 * already brings: TIC's CompanyRoles enrichment of Bolagsverket's register,
 * fetched for the BankID personnummer at every BankID login and stored per
 * user in `bankid_enrichment` (written by the service role only).
 *
 * The roles count only for a proven link (`email_verified_at`, see
 * lib/company-lookup/own-firm.ts) and only when they were read after the
 * BankID identity was linked to the account: roles left from an earlier
 * identity never count for a later one.
 */

/**
 * Bolagsverket's position codes (CompanyRoles `positionTypes`) whose holder
 * represents the company and signs its name:
 *
 *   LE, OF      styrelseledamot, ordförande: the board represents the company
 *               and signs its name (ABL 8 kap. 35 §)
 *   VD, EVD     verkställande direktör, also one outside the board (8 kap. 36 §)
 *   VVD, EVVD   vice verkställande direktör, under the VD rules (8 kap. 28 §)
 *   EFT         särskild firmatecknare outside the board (8 kap. 37 §)
 *   LI          likvidator, in the board's and the VD's place (25 kap. 30 §)
 *   BO, KP      bolagsman of a handelsbolag, komplementär of a kommanditbolag
 *               (HBL 2 kap. 17 §, 3 kap. 1 §)
 *
 * Not counted: styrelsesuppleant, revisor, kommanditdelägare (not behörig to
 * represent the company, HBL 3 kap. 7 §), delgivningsmottagare, prokurist,
 * likvidatorssuppleant and innehavare (a sole trader's firm has no business
 * mailbox).
 */
const SIGNATORY_POSITION_CODES: ReadonlySet<string> = new Set(['LE', 'OF', 'VD', 'EVD', 'VVD', 'EVVD', 'EFT', 'LI', 'BO', 'KP'])

interface StoredRole {
  companyRegistrationNumber?: unknown
  positionTypes?: unknown
  positionEnd?: unknown
  companyStatus?: unknown
}

/**
 * Whether stored CompanyRoles list a position that signs for `orgNumber`:
 * still held, in a company that has not ceased. `roles` is read straight from
 * a jsonb column, so anything that is not an array lists nothing.
 */
export function holdsSignatoryPosition(roles: unknown, orgNumber: string): boolean {
  const key = orgNumberKey(orgNumber)
  if (!key || !Array.isArray(roles)) return false
  return (roles as StoredRole[]).some((role) => {
    if (!role || typeof role.companyRegistrationNumber !== 'string') return false
    if (registrationNumberKey(role.companyRegistrationNumber) !== key) return false
    // Loose `!= null` on purpose, as in addableEngagements: TIC has sent undefined for an open position.
    if (role.positionEnd != null) return false
    if (isCeasedCompanyStatus(typeof role.companyStatus === 'string' ? role.companyStatus : null)) return false
    return Array.isArray(role.positionTypes) && role.positionTypes.some(
      (code) => typeof code === 'string' && SIGNATORY_POSITION_CODES.has(code.trim().toUpperCase()),
    )
  })
}

/**
 * 'proven': one of the people is a firmatecknare of the number.
 * 'not_signatory': none is, though at least one has register roles from a
 * proven BankID login to read.
 * 'no_bankid': none of them has a proven BankID login with roles read since
 * it was linked.
 */
export type SignatoryProof = 'proven' | 'not_signatory' | 'no_bankid'

/**
 * Whether any of `userIds` is a firmatecknare of `orgNumber` by their own
 * BankID (see the top of this file). Takes the service-role client. A failed
 * read throws: not knowing is not a proof.
 */
export async function bankIdSignatoryProof(
  service: SupabaseClient,
  userIds: readonly string[],
  orgNumber: string,
): Promise<SignatoryProof> {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0) return 'no_bankid'
  const [identities, enrichments] = await Promise.all([
    service.from('bankid_identities').select('user_id, email_verified_at, linked_at').in('user_id', ids),
    service.from('bankid_enrichment').select('user_id, company_roles, updated_at').in('user_id', ids),
  ])
  if (identities.error) throw new Error(`bankid identity read failed: ${identities.error.message}`)
  if (enrichments.error) throw new Error(`bankid enrichment read failed: ${enrichments.error.message}`)

  const linkedAt = new Map<string, number>()
  for (const row of (identities.data ?? []) as Array<{ user_id: string; email_verified_at: string | null; linked_at: string | null }>) {
    const at = row.linked_at ? Date.parse(row.linked_at) : Number.NaN
    if (row.email_verified_at && Number.isFinite(at)) linkedAt.set(row.user_id, at)
  }

  let readable = false
  for (const row of (enrichments.data ?? []) as Array<{ user_id: string; company_roles: unknown; updated_at: string | null }>) {
    const linked = linkedAt.get(row.user_id)
    const readAt = row.updated_at ? Date.parse(row.updated_at) : Number.NaN
    if (linked === undefined || !Number.isFinite(readAt) || readAt < linked) continue
    readable = true
    if (holdsSignatoryPosition(row.company_roles, orgNumber)) return 'proven'
  }
  return readable ? 'not_signatory' : 'no_bankid'
}
