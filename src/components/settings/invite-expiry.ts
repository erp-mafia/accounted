/**
 * True when an invitation's accept link has run out (`expires_at` reached).
 *
 * The one client-side definition for the member rosters
 * (CompanyMembersSection.tsx, TeamPanel.tsx). Neither invitation table flips
 * `status` when the expiry passes: 'expired' is written lazily, only when
 * someone tries the dead link (POST /api/team/accept answers 410 then). A
 * `pending` row past its expiry is therefore the normal shape of an expired
 * invitation, and the roster has to derive the state from `expires_at`
 * instead of rendering the stale date as a future one (crm#241).
 *
 * An unparseable timestamp is not called expired: the row keeps its existing
 * rendering rather than inventing a state.
 */
export function isInviteExpired(expiresAt: string, now: Date = new Date()): boolean {
  const expiry = new Date(expiresAt).getTime()
  return Number.isFinite(expiry) && expiry <= now.getTime()
}
