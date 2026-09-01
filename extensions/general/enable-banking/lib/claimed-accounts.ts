import type { StoredAccount } from '../types'

/**
 * Split a connection's accounts into the ones that belong in THIS company's
 * books and the ones the OAuth callback marked as already booked by another
 * of the user's companies (`claimed_by_company_id`, see lib/session-sharing).
 *
 * At one-session banks (SEB) a single BankID consent returns every account the
 * signer can see across all their companies, so a reconnect from company A
 * carries company B's accounts too. Since PR #2116 those arrive unchecked and
 * unmirrored; this helper is what keeps them out of the main list altogether,
 * so a user working in company A sees company A's accounts. The claimed set is
 * still returned (never dropped): the picker renders it behind a collapsed
 * disclosure, because an account that genuinely belongs here must stay
 * reachable (a claim is a strong hint, not proof of ownership).
 *
 * An account counts as claimed elsewhere only while it is BOTH flagged and
 * disabled here. Every writer keeps those two in step (the callback sets them
 * together, the selection save clears the flag on enable), but the invariant
 * is load-bearing: an account that syncs in this company must never be
 * tucked out of sight, so a flagged-but-enabled row (a future writer, a
 * support SQL fix) stays in the main list. The callback already lets the
 * active company's own standing state outrank a sibling claim, so a legacy
 * account enabled in both companies carries no flag and stays visible too.
 */
export function partitionByClaim<T extends Pick<StoredAccount, 'claimed_by_company_id' | 'enabled'>>(
  accounts: readonly T[],
): { own: T[]; claimedElsewhere: T[] } {
  const own: T[] = []
  const claimedElsewhere: T[] = []
  for (const account of accounts) {
    if (account.claimed_by_company_id && account.enabled === false) claimedElsewhere.push(account)
    else own.push(account)
  }
  return { own, claimedElsewhere }
}

/**
 * One Swedish line summarising the hidden accounts, e.g.
 * "2 konton synkas i Testbrand AB" or "3 konton synkas i andra bolag" when the
 * claimants differ (or a name is missing). "Same claimant" is decided on the
 * company id, not the display name: two companies can share a name. Empty
 * string for an empty list so callers can render conditionally on the text.
 */
export function describeClaimedElsewhere(
  accounts: readonly Pick<StoredAccount, 'claimed_by_company_id' | 'claimed_by_company_name'>[],
): string {
  if (accounts.length === 0) return ''
  const noun = accounts.length === 1 ? 'konto' : 'konton'
  const ids = new Set<string>()
  const names = new Set<string>()
  let anonymous = false
  for (const account of accounts) {
    if (account.claimed_by_company_id) ids.add(account.claimed_by_company_id)
    if (account.claimed_by_company_name) names.add(account.claimed_by_company_name)
    else anonymous = true
  }
  if (ids.size === 1 && names.size === 1 && !anonymous) {
    return `${accounts.length} ${noun} synkas i ${[...names][0]}`
  }
  return `${accounts.length} ${noun} synkas i ${accounts.length === 1 ? 'ett annat bolag' : 'andra bolag'}`
}
