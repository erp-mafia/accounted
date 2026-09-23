/**
 * Pure multi-user access model: no I/O, no env reads, imported by both
 * has-capability.ts (which derives the state from grant rows it already
 * fetched) and multi-user.ts (the async lookup helpers). Keep it that way:
 * this module must never import from either of them.
 *
 * The `multi_user` capability gates PEOPLE, not a feature surface, so its
 * lapse is softened by a grace window (founder decision 2026-09-01):
 *
 *   entitled : an active multi_user grant (trial/stripe/team/manual/comp).
 *              Everyone in the company works normally.
 *   grace    : the newest grant expired less than MULTI_USER_GRACE_DAYS ago.
 *              Everyone still works; the countdown banner shows.
 *   frozen   : expired at least MULTI_USER_GRACE_DAYS ago, or never granted.
 *              Only role = 'owner' memberships resolve; every other
 *              membership is dormant (rows untouched: paying reactivates
 *              them instantly), and new invites are blocked.
 *
 * The 20-day grace is the PERMANENT rule for every lapse (trial end,
 * subscription cancel, comp expiry), not a one-off migration affordance:
 * the grandfather backfill simply inserts a grant expiring at deploy time
 * so existing multi-member free companies enter the same window.
 *
 * company_capability_config is deliberately ignored for this key: a config
 * disable has no expiry to hang the grace window on, and freezing people
 * out of their bookkeeping must never happen through a side channel. The
 * DB twin (public.company_multi_user_ok) implements the same rule.
 */

export const MULTI_USER_GRACE_DAYS = 20

const GRACE_MS = MULTI_USER_GRACE_DAYS * 86_400_000

export type MultiUserState = 'entitled' | 'grace' | 'frozen'

export interface MultiUserAccess {
  state: MultiUserState
  /** End of the post-lapse grace window (ISO); set only while state === 'grace'. */
  graceEndsAt: string | null
}

export interface MultiUserGrantRow {
  expires_at: string | null
}

/** Derive the access state from the company's multi_user grant rows. */
export function computeMultiUserState(
  rows: readonly MultiUserGrantRow[],
  now: number,
): MultiUserAccess {
  let newestExpiryMs: number | null = null
  for (const row of rows) {
    if (row.expires_at === null) return { state: 'entitled', graceEndsAt: null }
    const expiryMs = new Date(row.expires_at).getTime()
    if (Number.isNaN(expiryMs)) continue
    if (expiryMs > now) return { state: 'entitled', graceEndsAt: null }
    if (newestExpiryMs === null || expiryMs > newestExpiryMs) newestExpiryMs = expiryMs
  }
  if (newestExpiryMs !== null && newestExpiryMs + GRACE_MS > now) {
    return { state: 'grace', graceEndsAt: new Date(newestExpiryMs + GRACE_MS).toISOString() }
  }
  return { state: 'frozen', graceEndsAt: null }
}

/**
 * The dormancy rule, in one place. Owners always keep access (a company must
 * never lock out the person who can pay); everyone else needs the company to
 * be entitled or in grace. Membership `source` is deliberately NOT consulted
 * (founder decision 2026-09-01, superseding the earlier byrå exemption):
 * byrå consultants stay in through the company's or their team's grant, not
 * through a role carve-out.
 */
export function isMembershipDormant(role: string, state: MultiUserState): boolean {
  return state === 'frozen' && role !== 'owner'
}
