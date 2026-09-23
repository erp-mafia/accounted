/**
 * Shared consumption of the pre-auth invite cookie.
 *
 * `app/invite/[token]/page.tsx` drops the raw invite token into
 * `gnubok-invite-token` before sending an invitee off to log in or register.
 * Every auth surface that can complete a session (login, register, MFA
 * verify) has to pick that token back up and POST it to /api/team/accept,
 * otherwise the invitee lands in the app without the membership they were
 * invited to.
 *
 * The rule this helper exists to enforce: the cookie is deleted ONLY on a
 * definitive outcome. Those surfaces each used to clear it unconditionally,
 * so a network blip or a 500 from /api/team/accept destroyed the token even
 * though the invitation was still `pending` in the database. The cookie is
 * the only copy the browser holds, so nothing short of the inviter re-sending
 * the invitation could recover it.
 *
 * Retention is a real recovery path, not just a deferral: `/onboarding` and
 * `/select-company` both re-run acceptance server-side from the surviving
 * cookie via `acceptPendingInviteByToken()` (lib/company/pending-invites.ts),
 * and the dashboard root redirects a company-less user straight to
 * `/onboarding`. A retained token therefore gets retried on the very next
 * page load.
 *
 * Security note: retention does not widen the token's authority. Its lifetime
 * is bounded server-side by `company_invitations.expires_at` (7 days) and by
 * the single-use `status` transition, both enforced on every POST in
 * app/api/team/accept/route.ts; the cookie's own `max-age` is set at write
 * time and is untouched here. Acceptance is re-authorized on every attempt
 * (`requireAuth()` plus an email equality check against the invitation), so a
 * surviving cookie confers nothing on its own.
 */

export const INVITE_COOKIE_NAME = 'gnubok-invite-token'

const ACCEPT_ENDPOINT = '/api/team/accept'

/**
 * What POST /api/team/accept told us about the token's fate.
 *
 * - `accepted`   the invitee is a member of the company now.
 * - `spent`      the token is genuinely used up or invalid: it can never work.
 * - `wrong_email` the signed-in account is not the invited one. The invitation
 *                 is untouched and still pending; the wrong account simply
 *                 cannot redeem it.
 * - `retryable`  nothing conclusive happened. The token is still live.
 *
 * `accepted` and `spent` are the only definitive outcomes, and therefore the
 * only ones that may clear the cookie.
 */
export type InviteAcceptDisposition = 'accepted' | 'spent' | 'wrong_email' | 'retryable'

/**
 * Map an HTTP status from POST /api/team/accept onto a disposition.
 *
 * Derived from app/api/team/accept/route.ts:
 *
 * | Status | Route meaning                          | Disposition   |
 * |--------|----------------------------------------|---------------|
 * | 2xx    | membership created, invite accepted    | accepted      |
 * | 409    | 'Du är redan medlem.'                  | accepted      |
 * | 400    | token missing, unknown, or not pending | spent         |
 * | 404    | invitation not found (GET shape)       | spent         |
 * | 410    | 'Inbjudan har gått ut.' (+ marked so)  | spent         |
 * | 403    | 'E-postadressen matchar inte...'       | wrong_email   |
 * | other  | 401 session race, 429, 5xx, proxy hiccup | retryable   |
 *
 * 409 counts as accepted: the invitee is in the company, which is the whole
 * point of holding the token. 401 is deliberately retryable rather than a
 * hard failure: it means the session cookie had not propagated yet, and the
 * next attempt (or the server-side retry on /onboarding) succeeds.
 */
export function classifyInviteAcceptStatus(status: number): InviteAcceptDisposition {
  if (status >= 200 && status < 300) return 'accepted'

  switch (status) {
    case 409:
      return 'accepted'
    case 400:
    case 404:
    case 410:
      return 'spent'
    case 403:
      return 'wrong_email'
    default:
      return 'retryable'
  }
}

/** Only a definitive disposition may destroy the token. */
export function isDefinitiveInviteDisposition(disposition: InviteAcceptDisposition): boolean {
  return disposition === 'accepted' || disposition === 'spent'
}

/** Non-success dispositions the caller has to surface to the user. */
export type InviteAcceptProblem = Exclude<InviteAcceptDisposition, 'accepted'>

/**
 * i18n keys (namespace `invite`) for each problem. Kept here so the four auth
 * surfaces render the same wording instead of inventing their own.
 */
export const INVITE_PROBLEM_MESSAGE_KEYS: Record<
  InviteAcceptProblem,
  { title: string; body: string }
> = {
  retryable: { title: 'accept_retry_title', body: 'accept_retry_body' },
  wrong_email: { title: 'accept_wrong_email_title', body: 'accept_wrong_email_body' },
  spent: { title: 'accept_spent_title', body: 'accept_spent_body' },
}

export interface ConsumeInviteCookieResult {
  /** False when there was no invite to process: the caller keeps its normal flow. */
  attempted: boolean
  /** Null only when `attempted` is false. */
  disposition: InviteAcceptDisposition | null
  /** True when the invitee is now a member: land them in the app. */
  accepted: boolean
  /** True when the token was removed from the browser. */
  cleared: boolean
  /** Null on success; otherwise the message the caller must show. */
  problem: InviteAcceptProblem | null
}

const NO_INVITE: ConsumeInviteCookieResult = {
  attempted: false,
  disposition: null,
  accepted: false,
  cleared: false,
  problem: null,
}

/**
 * Read the raw invite token from the cookie jar. Anchored on a cookie
 * boundary so a differently-named cookie ending in the same suffix cannot
 * masquerade as the invite token.
 */
export function readInviteCookie(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${INVITE_COOKIE_NAME}=([^;]*)`),
  )
  const value = match?.[1]
  return value ? value : null
}

/**
 * Expire the invite cookie. Same attributes the auth surfaces have always
 * used: path-scoped delete, no change to domain, samesite or secure.
 */
export function clearInviteCookie(): void {
  if (typeof document === 'undefined') return
  document.cookie = `${INVITE_COOKIE_NAME}=; path=/; max-age=0`
}

/**
 * Read the pending invite token, try to accept it, and clear the cookie only
 * if the outcome was definitive.
 *
 * Pass `token` explicitly when the caller already has it out of band (the
 * invite page reads it from the route params); the cookie is still cleared on
 * a definitive outcome so a stale copy does not linger.
 */
export async function consumeInviteCookie(
  options: { token?: string | null } = {},
): Promise<ConsumeInviteCookieResult> {
  const token = options.token ?? readInviteCookie()
  if (!token) return NO_INVITE

  let disposition: InviteAcceptDisposition

  try {
    const res = await fetch(ACCEPT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    disposition = classifyInviteAcceptStatus(res.status)
  } catch (err) {
    // The request never reached the server, so the invitation is certainly
    // still pending. Keep the token.
    console.error('[invite] acceptance request failed:', err)
    disposition = 'retryable'
  }

  const cleared = isDefinitiveInviteDisposition(disposition)
  if (cleared) clearInviteCookie()

  return {
    attempted: true,
    disposition,
    accepted: disposition === 'accepted',
    cleared,
    problem: disposition === 'accepted' ? null : disposition,
  }
}
