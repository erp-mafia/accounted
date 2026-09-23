import {
  consumeInviteCookie,
  readInviteCookie,
  type InviteAcceptProblem,
} from '@/lib/auth/consume-invite-cookie'
import { shouldEnforceMfa } from '@/lib/auth/mfa'

/**
 * Invite handoff for the password-recovery flow.
 *
 * `/reset-password` was the only session-establishing path that never picked
 * the pre-auth invite cookie back up. Login, register and `/mfa/verify` all
 * call `consumeInviteCookie()`; the recovery flow did not, and the server-side
 * safety nets do not cover it. `acceptPendingInviteByToken()`
 * (lib/company/pending-invites.ts) runs only on `/onboarding` and
 * `/select-company`, and `/onboarding` is reachable only for a user with zero
 * companies. A consultant who already has a company of their own therefore had
 * no route back to the invitation at all after resetting their password.
 *
 * This module holds the decision only. The POST, the status classification and
 * the "clear the cookie on a definitive outcome, keep it otherwise" rule all
 * stay in `lib/auth/consume-invite-cookie.ts`: this is the fifth caller of that
 * helper, not a fifth copy of it.
 *
 * It lives beside `page.tsx` rather than inside it because a Next.js page file
 * may not export anything but the page component and the route segment config,
 * which would leave the flow untestable in a repo with no component harness.
 */

/** Only the field the MFA predicate reads off the authenticated user. */
export interface InviteHandoffUser {
  app_metadata?: Record<string, unknown>
}

/** Current vs required assurance level for the live session. */
export interface InviteHandoffAssuranceLevel {
  currentLevel: string | null
  nextLevel: string | null
}

export interface InviteHandoffDeps {
  /** The authenticated user, or null when it could not be read. */
  getUser: () => Promise<InviteHandoffUser | null>
  /** The session's assurance levels, or null when they could not be read. */
  getAssuranceLevel: () => Promise<InviteHandoffAssuranceLevel | null>
  /** Show the user a non-definitive outcome. */
  reportProblem: (problem: InviteAcceptProblem) => void
}

/**
 * Where a user whose invite survived an inconclusive attempt is sent so the
 * server can retry it. `/select-company` re-runs `acceptPendingInviteByToken()`
 * on every load and, unlike `/onboarding`, is reachable for a user who already
 * has a company (lib/supabase/middleware.ts lets it through with a resolved
 * active company). That makes it the only healing surface for the user shape
 * this whole handoff exists for.
 */
export const INVITE_RETRY_DESTINATION = '/select-company'

/** Where a settled invite lands the user. */
export const INVITE_ACCEPTED_DESTINATION = '/'

/**
 * Accept a pending invitation once the password reset itself is finished.
 *
 * MUST be called only after `POST /api/account/password` has returned 2xx.
 * That route runs `requireAuth()`, so its success proves a server-validated
 * session exists, and waiting for it means no membership is ever created off a
 * half-completed recovery. Authorization is not this function's business:
 * `/api/team/accept` re-authorizes every attempt with `requireAuth()` plus an
 * email equality check against the invitation.
 *
 * Returns the path to hard-navigate to, or null to keep the caller's normal
 * post-reset navigation. Null covers every case where nothing changed
 * server-side: no invitation in flight, a step-up still owed, a spent token, or
 * an invitation belonging to another address.
 *
 * Never throws, so a hiccup in the invite handoff can never be mistaken for a
 * failed password reset by the caller's error path.
 */
export async function handoffPendingInvite(
  deps: InviteHandoffDeps,
): Promise<string | null> {
  // No invitation in flight: no requests, no toast, untouched flow.
  if (!readInviteCookie()) return null

  if (await mfaStepUpOwed(deps)) return null

  const invite = await consumeInviteCookie()
  if (invite.problem) deps.reportProblem(invite.problem)

  if (invite.accepted) return INVITE_ACCEPTED_DESTINATION

  // Retain-and-retry, for transient failures only. `wrong_email` is
  // deterministic for this account (the server-side email equality check would
  // fail identically), and `spent` already destroyed the token, so neither
  // gains anything from the server-side retry: both just show the toast and
  // keep the normal flow.
  if (invite.disposition === 'retryable') return INVITE_RETRY_DESTINATION

  return null
}

/**
 * True when the middleware would reject the acceptance for want of a step-up.
 *
 * `POST /api/team/accept` sits BEHIND the middleware MFA gate: it is not in
 * `apiPathSkipsMfaGate` (lib/auth/api-mfa-gate.ts), and a recovery session is
 * AAL1. Attempting the acceptance while a step-up is owed returns a bare 403,
 * which the shared classifier cannot tell apart from an email mismatch, so a
 * legitimate invitee would be told their invitation belongs to someone else.
 *
 * The predicate mirrors the middleware's own condition exactly
 * (`shouldEnforceMfa` plus aal1-with-aal2-required), which makes "we skipped"
 * and "the middleware will bounce this user to /mfa/verify" the same statement:
 * the cookie survives untouched and `/mfa/verify` consumes it once the second
 * factor is in. A user whose MFA is not enforced (self-hosted, BankID-linked)
 * is deliberately never deferred, because nothing would bounce them and the
 * token would sit there unused.
 *
 * A failed read is not evidence of a pending step-up, so it falls through to
 * the attempt: the server is the authority, and a 403 keeps the token anyway.
 */
async function mfaStepUpOwed(deps: InviteHandoffDeps): Promise<boolean> {
  try {
    const user = await deps.getUser()
    if (!user || !shouldEnforceMfa(user)) return false

    const aal = await deps.getAssuranceLevel()
    return aal?.nextLevel === 'aal2' && aal.currentLevel === 'aal1'
  } catch (err) {
    console.error('[reset-password] could not read the session MFA state', err)
    return false
  }
}
