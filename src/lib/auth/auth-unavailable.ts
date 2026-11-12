import { NextResponse } from 'next/server'

/**
 * What the proxy answers when a request carries a session it could not
 * check: Supabase Auth rate limited the refresh, answered 5xx, or was not
 * reachable (lib/supabase/auth-call-budget.ts, AuthServiceWatch).
 *
 * That is not "signed out". Until 2026-11 it was treated as exactly that:
 * the session cookies were cleared and the request bounced to /login, so a
 * rate limit that one looping client caused logged out everyone sharing its
 * IP whose token came up for refresh, mid-work, with no reason shown. The
 * session is still valid at the auth service; the answer is to keep the
 * cookies and say "try again", for a page with a reload that happens by
 * itself.
 */

/** The wait named on the response when the auth service gave none. */
const DEFAULT_RETRY_SECONDS = 10
const MIN_RETRY_SECONDS = 5
const MAX_RETRY_SECONDS = 60

export const AUTH_UNAVAILABLE_CODE = 'AUTH_UNAVAILABLE'

const MESSAGE_SV = 'Vi kunde inte kontrollera din inloggning just nu. Du är fortfarande inloggad. Försök igen om en stund.'
const MESSAGE_EN = 'We could not check your sign-in right now. You are still signed in. Try again in a moment.'

function retrySeconds(retryAfterSeconds: number | null): number {
  const wanted = retryAfterSeconds ?? DEFAULT_RETRY_SECONDS
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, Math.ceil(wanted)))
}

/**
 * API routes that have to answer without a checked session: signing in
 * (password, one-time code, BankID), signing up, asking for a reset and
 * signing out. Everything else under /api
 * answers the 503 below instead of a 401, because the browser reads a 401 as
 * "no session" and sends the user to /login.
 */
const SESSIONLESS_AUTH_ROUTES: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/otp',
  '/api/auth/sso',
  '/api/auth/oauth',
  '/api/auth/anonymous',
  '/api/auth/signup',
  '/api/auth/password-reset',
])

/** BankID sign-in and sign-up (start, collect, complete, cancel) run before a session exists. */
const BANKID_SIGN_IN_PREFIX = '/api/extensions/ext/tic/bankid/'

/**
 * APIs behind the public token pages (attest, sign, pay, connect a bank,
 * payslip, verify a signed copy): the token in the request is the
 * credential, and a visitor's own stale session has no say in them.
 */
const TOKEN_API_PREFIXES = ['/api/attest/', '/api/signera/', '/api/betala/', '/api/koppla/', '/api/payslip/', '/api/verifiera']

export function apiPathAnswersWithoutSession(pathname: string): boolean {
  return (
    SESSIONLESS_AUTH_ROUTES.has(pathname) ||
    pathname.startsWith(BANKID_SIGN_IN_PREFIX) ||
    TOKEN_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
}

/** 503 for an API request whose cookie session could not be checked. */
export function authUnavailableApiResponse(retryAfterSeconds: number | null): NextResponse {
  const wait = retrySeconds(retryAfterSeconds)
  return NextResponse.json(
    { error: { code: AUTH_UNAVAILABLE_CODE, message: MESSAGE_SV, message_en: MESSAGE_EN } },
    { status: 503, headers: { 'Retry-After': String(wait), 'Cache-Control': 'no-store' } },
  )
}

/**
 * 503 page for a protected page whose session could not be checked. Plain
 * HTML with no script and no app chrome: it is written by the proxy, on any
 * brand's host, at a moment the app cannot render. It reloads itself after
 * the wait (a meta refresh, which the CSP does not restrict) and offers the
 * same reload as a link; an empty href is the current URL, so nothing from
 * the request is written into the page.
 */
export function authUnavailablePageResponse(
  retryAfterSeconds: number | null,
  locale: 'sv' | 'en',
): NextResponse {
  const wait = retrySeconds(retryAfterSeconds)
  const text =
    locale === 'en'
      ? {
          title: 'Try again in a moment',
          body: 'We could not check your sign-in right now. You are still signed in and nothing is lost.',
          reload: `This page reloads by itself in ${wait} seconds.`,
          action: 'Reload now',
        }
      : {
          title: 'Försök igen om en stund',
          body: 'Vi kunde inte kontrollera din inloggning just nu. Du är fortfarande inloggad och inget har gått förlorat.',
          reload: `Sidan laddas om av sig själv om ${wait} sekunder.`,
          action: 'Ladda om nu',
        }
  const html = `<!doctype html>
<html lang="${locale}" translate="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="${wait}">
<title>${text.title}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#fff;color:#111}main{max-width:28rem;margin:20vh auto 0;padding:0 1.5rem}h1{font-size:1.25rem;font-weight:600}p{line-height:1.5}a{color:inherit}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>
</head>
<body>
<main>
<h1>${text.title}</h1>
<p>${text.body}</p>
<p>${text.reload}</p>
<p><a href="">${text.action}</a></p>
</main>
</body>
</html>`
  return new NextResponse(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(wait),
      'Cache-Control': 'no-store',
    },
  })
}
