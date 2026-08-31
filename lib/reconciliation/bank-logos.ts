/**
 * Bank logos for the reconciliation rail. Resolved by name (the connection's
 * bank_name from the connect flow, falling back to the account name) against
 * the brand icons committed under public/logos/banks/: the set covers every
 * bank with a live connection in prod as of 2026-08-24. No match (the small
 * sparbanker, file-imported accounts) falls back to the monogram; that is a
 * presentation default, never an error.
 */

const BANK_LOGO_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/handelsbanken/, 'handelsbanken'],
  [/swedbank/, 'swedbank'],
  [/\bseb\b/, 'seb'],
  [/nordea/, 'nordea'],
  [/\blunar\b/, 'lunar'],
  [/\bsvea\b/, 'svea'],
  [/l[aä]nsf[oö]rs[aä]kringar/, 'lansforsakringar'],
  [/revolut/, 'revolut'],
  [/\bwise\b/, 'wise'],
  [/danske/, 'danske'],
  [/klarna/, 'klarna'],
  [/northmill/, 'northmill'],
  [/paypal/, 'paypal'],
  [/stripe/, 'stripe'],
]

/**
 * First matching brand icon for any of the candidate names (checked in
 * order), or null for the monogram fallback.
 */
export function bankLogoUrl(...names: Array<string | null | undefined>): string | null {
  for (const name of names) {
    if (!name) continue
    const haystack = name.toLowerCase()
    for (const [pattern, slug] of BANK_LOGO_PATTERNS) {
      if (pattern.test(haystack)) return `/logos/banks/${slug}.png`
    }
  }
  return null
}
