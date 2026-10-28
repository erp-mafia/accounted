import { orgNumberKey, registrationNumberKey } from '@/lib/invariants/org-number'
import type { EnrichmentCompanyRole } from './types'

/**
 * BankID engagements: the companies a person holds a registered position in,
 * from TIC's CompanyRoles enrichment of Bolagsverket's register. Fetched at
 * every BankID login and stored per user in `bankid_enrichment`.
 *
 * The register keeps a position for as long as the company keeps it, and a
 * company that is struck off, merged away or dissolved keeps its last board
 * for good. So an open position (no `positionEnd`) is no sign of a live
 * company: none of the 2,788 roles stored in production on 2026-10-05 had
 * one, 788 of them in companies with a status event. The company's own
 * state is `companyStatus`: absent for a company with no registered status
 * event, a TIC status code otherwise.
 */

/**
 * Status families after which the company no longer exists, so there are no
 * books to keep in Accounted. Matched by prefix so that a sibling code is
 * covered too: Deregistered, DeregisteredNewHolder; DissolvedByMergerProcedure;
 * CompanyStruckOff, CompanyStruckOffOwnRequest,
 * CompanyStruckOffByRegistrationOffice, CompanyStruckOffTradeRegisterAct.
 */
const CEASED_STATUS_PREFIXES = ['Deregistered', 'Dissolved', 'CompanyStruckOff'] as const

/** Proceedings that end with the company dissolved. */
const CEASED_STATUSES: ReadonlySet<string> = new Set([
  'BankruptcyProceedingsTerminated',
  'LiquidationTerminated',
])

/**
 * True when a CompanyRoles `companyStatus` says the company has ceased.
 *
 * Fails open: no status (an active company), an ongoing proceeding (a
 * liquidation decided, a reorganisation, a bankruptcy just opened), an event
 * the company outlives (BankruptcyTerminatedWithSurplus, LiquidationEnds,
 * ReorganizationOfBusinessEnded, AcquisitionTerminated: companies with those
 * statuses are booked in Accounted today) and any unknown code all count as
 * live. Hiding a real company is worse than listing a dead one: a pick still
 * runs the journey's own register lookup, which stops on a ceased company.
 */
export function isCeasedCompanyStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return (
    CEASED_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix)) ||
    CEASED_STATUSES.has(status)
  )
}

/**
 * The engagements worth offering under "Lägg till företag": positions still
 * held, in companies that still exist, that are not among the user's own
 * companies yet.
 *
 * `memberOrgNumbers` are the org numbers of the user's non-archived companies
 * as stored. Both sides go through the shared key, because a sole trader's
 * CompanyRoles entry is the 16-digit TIC registration number while Accounted
 * stores the firm under the 10-digit personnummer.
 *
 * `roles` is read straight from a jsonb column, so anything that is not an
 * array is treated as no engagements.
 */
export function addableEngagements(
  roles: unknown,
  memberOrgNumbers: ReadonlyArray<string | null | undefined>,
): EnrichmentCompanyRole[] {
  if (!Array.isArray(roles)) return []

  const memberKeys = new Set(
    memberOrgNumbers
      .map((orgNumber) => orgNumberKey(orgNumber))
      .filter((key): key is string => !!key),
  )

  return (roles as EnrichmentCompanyRole[]).filter((role) => {
    // Loose `== null` on purpose: TIC has been observed returning
    // `undefined` for an open-ended position, which `=== null` would miss.
    if (role.positionEnd != null) return false
    if (isCeasedCompanyStatus(role.companyStatus)) return false
    const key = registrationNumberKey(role.companyRegistrationNumber)
    return !key || !memberKeys.has(key)
  })
}

/**
 * Whether an account can have engagements stored at all. Only a BankID
 * session writes `bankid_enrichment` (the tic extension), and the same flow
 * marks the account with `bankid_pending` and then `bankid_linked`; unlinking
 * sets the flag to false but keeps the key. So an account with neither key
 * has no engagements, and callers can skip the `bankid_enrichment` read
 * (production 2026-10-28: every one of the 1,182 enrichment rows belongs to an
 * account carrying one of the keys).
 */
export function mayHaveBankIdEngagements(appMetadata: Record<string, unknown> | null | undefined): boolean {
  return !!appMetadata && ('bankid_linked' in appMetadata || 'bankid_pending' in appMetadata)
}
