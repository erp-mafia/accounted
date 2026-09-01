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
 * The flag alone decides. The callback already lets the active company's own
 * standing state outrank a sibling claim, so a legacy account enabled in both
 * companies carries no flag here and stays in the main list.
 */
export function partitionByClaim<T extends Pick<StoredAccount, 'claimed_by_company_id'>>(
  accounts: readonly T[],
): { own: T[]; claimedElsewhere: T[] } {
  const own: T[] = []
  const claimedElsewhere: T[] = []
  for (const account of accounts) {
    if (account.claimed_by_company_id) claimedElsewhere.push(account)
    else own.push(account)
  }
  return { own, claimedElsewhere }
}

/**
 * One Swedish line summarising the hidden accounts, e.g.
 * "2 konton synkas i Testbrand AB" or "3 konton synkas i andra bolag" when the
 * claimants differ (or a name is missing). Empty string for an empty list so
 * callers can render conditionally on the text.
 */
export function describeClaimedElsewhere(
  accounts: readonly Pick<StoredAccount, 'claimed_by_company_id' | 'claimed_by_company_name'>[],
): string {
  if (accounts.length === 0) return ''
  const noun = accounts.length === 1 ? 'konto' : 'konton'
  const names = new Set<string>()
  let anonymous = false
  for (const account of accounts) {
    if (account.claimed_by_company_name) names.add(account.claimed_by_company_name)
    else anonymous = true
  }
  if (names.size === 1 && !anonymous) {
    return `${accounts.length} ${noun} synkas i ${[...names][0]}`
  }
  return `${accounts.length} ${noun} synkas i ${accounts.length === 1 ? 'ett annat bolag' : 'andra bolag'}`
}
