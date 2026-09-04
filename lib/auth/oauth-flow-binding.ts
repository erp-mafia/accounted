import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'

/**
 * Bind the completion of a browser-driven OAuth/consent flow to the user who
 * started it.
 *
 * Our OAuth callbacks (Enable Banking, Stripe Connect, WooCommerce wc-auth)
 * locate the pending connection row by the single-use `oauth_state` token and
 * then finalize it for that row's `user_id` / `company_id`. The token proves
 * the callback belongs to a flow WE started; it does not prove that the
 * browser completing it belongs to the user who started it. Without this
 * check, a victim who is lured into completing a consent an attacker
 * initiated (the authorize URL is shareable) has their bank / Stripe / store
 * attached to the attacker's company.
 *
 * Consent redirects are top-level navigations, so on the legitimate path the
 * initiator's own session cookies arrive with the callback. This helper reads
 * that cookie session and compares it to the expected initiator.
 *
 * Outcomes:
 *   - ok: the session user is the initiator; carry on.
 *   - no_session: nobody is signed in (expired mid-flow, cookies cleared).
 *     `response` redirects to /login?next=<this callback URL> so the initiator
 *     can sign in and the callback re-runs with the same code + state.
 *   - mismatch: a different user is signed in. `response` is a 403 in the
 *     canonical error envelope; a route whose UX is a settings redirect
 *     inspects `reason` and builds its own redirect instead. The mismatch is
 *     logged with both ids redacted to prefixes.
 *
 * Deliberately not `requireAuth()`: this is an equality check on identity,
 * not an authorization gate. The route that STARTED the flow already ran the
 * MFA-enforcing guard for this user, and a 403 here for an aal1 session would
 * strand the user (the callback has no MFA prompt to send them to).
 */

const log = createLogger('auth/oauth-flow-binding')

/** Swedish user-facing message for the mismatch outcome (shared by callers). */
export const FLOW_INITIATOR_MISMATCH_MESSAGE =
  'Anslutningen kunde inte slutföras: den startades från ett annat användarkonto än det du är inloggad med. Logga in med det kontot eller starta anslutningen på nytt.'

export const FLOW_INITIATOR_MISMATCH_MESSAGE_EN =
  'The connection could not be completed: it was started from a different user account than the one you are signed in with. Sign in with that account or start the connection again.'

export type FlowInitiatorResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'no_session'; response: Response }
  | { ok: false; reason: 'mismatch'; response: Response; sessionUserId: string }

export interface RequireFlowInitiatorOptions {
  /** Short label for the log line, e.g. 'stripe.callback'. */
  flow?: string
}

/**
 * Shorten a user id to a stable prefix for log lines. Enough to correlate two
 * log records, not enough to identify the account outside the database.
 */
export function redactUserId(id: string | null | undefined): string {
  if (!id) return '(none)'
  return id.length <= 8 ? id : `${id.slice(0, 8)}...`
}

/**
 * The /login redirect for a callback reached without a session. `next` is the
 * callback's own path + query (same-origin relative, which is the only form
 * the login page's safeReturnTo accepts), so signing in resumes the flow.
 */
export function buildLoginRedirect(request: Request): Response {
  const current = new URL(request.url)
  const appOrigin = process.env.NEXT_PUBLIC_APP_URL || current.origin
  const next = `${current.pathname}${current.search}`
  const login = new URL('/login', appOrigin)
  login.searchParams.set('next', next)
  return NextResponse.redirect(login.toString())
}

export async function requireFlowInitiator(
  request: Request,
  expectedUserId: string,
  options: RequireFlowInitiatorOptions = {},
): Promise<FlowInitiatorResult> {
  const flow = options.flow ?? 'oauth-callback'
  const path = new URL(request.url).pathname

  let sessionUserId: string | null = null
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (!error && data?.user?.id) sessionUserId = data.user.id
  } catch (err) {
    // Fail closed: an auth outage or a missing request scope is treated as
    // "no session". The login redirect below re-runs the callback once a
    // session can be read, nothing is finalized on a guess.
    log.error('could not read the cookie session for an OAuth callback', err as Error, {
      flow,
      path,
    })
  }

  if (!sessionUserId) {
    log.warn('oauth callback reached without a session; sending to login', {
      flow,
      path,
      expectedUser: redactUserId(expectedUserId),
    })
    return { ok: false, reason: 'no_session', response: buildLoginRedirect(request) }
  }

  if (sessionUserId !== expectedUserId) {
    log.warn('oauth callback completed by a different user than the initiator', {
      flow,
      path,
      expectedUser: redactUserId(expectedUserId),
      sessionUser: redactUserId(sessionUserId),
      alert: true,
    })
    const response = NextResponse.json(
      {
        error: {
          code: 'OAUTH_FLOW_INITIATOR_MISMATCH',
          message: FLOW_INITIATOR_MISMATCH_MESSAGE,
          message_en: FLOW_INITIATOR_MISMATCH_MESSAGE_EN,
        },
      },
      { status: 403 },
    )
    return { ok: false, reason: 'mismatch', response, sessionUserId }
  }

  return { ok: true, userId: sessionUserId }
}
