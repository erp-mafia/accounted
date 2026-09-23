/**
 * Deletion gate for the account danger zone (AccountDangerZone.tsx).
 *
 * `blockers === null` means the owned-companies read has not produced a
 * trustworthy answer: still loading, or the request failed. An unknown
 * blocker list must read as "cannot permit deletion", never as "no blockers".
 * The server enforces the same precondition with a 409, but the button on the
 * most destructive settings surface must not claim an unblocked path the
 * client has not confirmed.
 */

export interface OwnedCompanyBlocker {
  id: string
  name: string
}

export function canDeleteAccount(blockers: OwnedCompanyBlocker[] | null): boolean {
  return blockers !== null && blockers.length === 0
}
