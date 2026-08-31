import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { createLogger } from '@/lib/logger'
import {
  PROXY_TIMING_HEADER,
  classifyProxyRequest,
  createProxyTimings,
  formatProxyServerTiming,
  proxyRouteTemplate,
  timed,
  type ProxyTimings,
} from '@/lib/supabase/proxy-timing'
import { shouldEnforceMfa } from '@/lib/auth/mfa'
import { apiPathSkipsMfaGate } from '@/lib/auth/api-mfa-gate'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/i18n/config'
import { userHasPassword } from '@/lib/auth/has-password'
import { isEmailOnBrandAllowlist } from '@/lib/auth/brand-signup-gate'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { normalizeHost, resolveBrandByHost } from '@/lib/branding/resolve'
import {
  apiRequestSkipsSessionTimeout,
  createSessionTimeoutState,
  evaluateSessionTimeout,
  fetchAutoLogoutPreference,
  getSessionTimeoutConfig,
  sessionStateMatchesUser,
  sessionStateNeedsRemint,
  sessionTimeoutClearCookieOptions,
  sessionTimeoutCookieOptions,
  signSessionTimeoutState,
  verifySessionTimeoutState,
} from '@/lib/auth/session-timeout'
import {
  isSessionAuthMethod,
  SESSION_AUTH_METHOD_HINT_COOKIE,
  SESSION_TIMEOUT_COOKIE,
  SESSION_TIMEOUT_REASON_HEADER,
  type SessionAuthMethod,
  type SessionTimeoutReason,
} from '@/lib/auth/session-timeout-shared'

const log = createLogger('proxy')

/**
 * Host-scoped marker that the signed-in user is on their home domain, so the
 * affinity check below costs zero queries on the hot path. Expiry re-runs the
 * check, which bounds staleness after team-membership changes.
 */
const HOME_DOMAIN_OK_COOKIE = 'gnubok-home-ok'
const HOME_DOMAIN_OK_MAX_AGE = 15 * 60

/**
 * Auth proxy entry point. Wraps the real work so every response carries a
 * per-phase timing header and emits one structured log line, mirroring what
 * withRouteContext does for API routes: without it the proxy's sequential
 * network calls (getUser, session state, company RPC, MFA lookups) were the
 * one part of a request nobody could measure. Page/RSC/prefetch responses
 * get `Server-Timing` (visible in the browser Timing tab); /api responses
 * get `X-Proxy-Timing` so the route wrapper's own Server-Timing is left
 * alone. Token-carrying paths are collapsed before logging.
 */
export async function updateSession(request: NextRequest) {
  const start = Date.now()
  const timing = createProxyTimings()
  const response = await updateSessionInner(request, timing)
  const totalMs = Date.now() - start
  const pathname = request.nextUrl.pathname
  const kind = classifyProxyRequest(pathname, request.headers)
  response.headers.set(
    kind === 'api' ? PROXY_TIMING_HEADER : 'Server-Timing',
    formatProxyServerTiming(timing, totalMs),
  )
  log.info('proxy completed', {
    kind,
    route: proxyRouteTemplate(pathname),
    status: response.status,
    ...timing,
    totalMs,
  })
  return response
}

async function updateSessionInner(
  request: NextRequest,
  timing: ProxyTimings,
): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
    error: authError,
  } = await timed(timing, 'authMs', () => supabase.auth.getUser())

  // Get the pathname
  const pathname = request.nextUrl.pathname

  // If the refresh token is stale/invalid, clear the session cookies so the
  // browser stops sending them on every request, INCLUDING /api requests,
  // which previously returned before this cleanup and replayed the dead
  // token forever. Skip on auth routes, the callback needs PKCE cookies
  // intact. scope: 'local' only clears cookies: the refresh token is already
  // dead server-side, and the default global-revoke round-trip re-triggers
  // the failed refresh, the exact AuthApiError this cleans up after.
  if (authError && !user && !pathname.startsWith('/auth')) {
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (signOutError) {
      // Expected session expiry, not a runtime error.
      console.warn('[middleware] session cleanup after stale refresh token failed', signOutError)
    }
  }

  const timeoutConfig = getSessionTimeoutConfig()
  const hasAuthorizationHeader = request.headers.get('authorization') !== null

  if (!user) {
    clearSessionTimeoutCookies(request, supabaseResponse)
  } else if (
    timeoutConfig.enabled &&
    !apiRequestSkipsSessionTimeout(pathname, hasAuthorizationHeader)
  ) {
    const encodedState = request.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
    const sessionId = await timed(timing, 'sessionMs', () =>
      getSupabaseSessionId(supabase),
    )
    const verifiedState = await timed(timing, 'sessionMs', () =>
      verifySessionTimeoutState(encodedState),
    )

    if (encodedState && !verifiedState) {
      await signOutTimedOutSession(supabase)
      return sessionTimeoutResponse(
        request,
        supabaseResponse,
        'absolute',
        'password',
      )
    }

    const stateMatches =
      verifiedState !== null &&
      sessionStateMatchesUser(verifiedState, user.id, sessionId)

    if (
      !verifiedState ||
      !stateMatches ||
      sessionStateNeedsRemint(verifiedState)
    ) {
      const hintedMethod = request.cookies.get(
        SESSION_AUTH_METHOD_HINT_COOKIE,
      )?.value
      const method = isSessionAuthMethod(hintedMethod)
        ? hintedMethod
        : 'password'
      const autoLogout = await timed(timing, 'sessionMs', () =>
        fetchAutoLogoutPreference(supabase, user.id),
      )

      // Unknown preference (failed read): mint nothing, so no fail-open
      // snapshot gets persisted; the next request retries the read.
      if (autoLogout !== null) {
        // A matching pre-toggle cookie keeps its timers: upgrading the shape
        // must not restart the absolute window.
        const state = verifiedState && stateMatches
          ? { ...verifiedState, autoLogout }
          : createSessionTimeoutState({
              userId: user.id,
              sessionId,
              method,
              autoLogout,
            })
        const signedState = await signSessionTimeoutState(state)

        if (signedState) {
          request.cookies.set(SESSION_TIMEOUT_COOKIE, signedState)
          supabaseResponse.cookies.set(
            SESSION_TIMEOUT_COOKIE,
            signedState,
            sessionTimeoutCookieOptions(),
          )
          clearAuthMethodHint(request, supabaseResponse)
        }
      }
    } else {
      const timeoutReason = evaluateSessionTimeout(
        verifiedState,
        timeoutConfig,
      )
      if (timeoutReason) {
        await signOutTimedOutSession(supabase)
        return sessionTimeoutResponse(
          request,
          supabaseResponse,
          timeoutReason,
          verifiedState.method,
        )
      }
    }
  }

  // ── API routes ──────────────────────────────────────────────────────────
  // API routes authenticate themselves (requireAuth, API-key Bearer, cron
  // secret, webhook signatures). Middleware runs on them for ONE reason: to
  // close the MFA gap. Many legacy routes hand-roll supabase.auth.getUser()
  // instead of requireAuth(), so without this an authenticated-but-not-MFA-
  // verified (AAL1) cookie session could reach them on the hosted product.
  // Gate ONLY cookie sessions. Bearer-auth SURFACES (/api/v1, the MCP
  // endpoint) and the AAL1 escape-hatch / OAuth routes pass straight through
  // (see apiPathSkipsMfaGate): header presence alone never skips the gate,
  // since the header is attacker-controlled and cookie-authenticated routes
  // ignore it. Pure Bearer callers (cron, webhooks) carry no cookie session,
  // so the `user` guard below already excludes them. Everything else about
  // /api auth stays the route's own responsibility.
  if (pathname.startsWith('/api')) {
    const skipMfaGate = apiPathSkipsMfaGate(
      pathname,
      hasAuthorizationHeader,
    )
    if (!skipMfaGate && user && shouldEnforceMfa(user)) {
      const { data: aal } = await timed(timing, 'mfaMs', () =>
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      )
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
        return NextResponse.json({ error: 'MFA-verifiering krävs.' }, { status: 403 })
      }
    }
    return supabaseResponse
  }

  // Invite pages: accessible to everyone, signed in or not. A user who
  // already has an account and is signed in should still be able to land on
  // /invite/[token] to accept the invite with one click (see
  // app/invite/[token]/page.tsx). If we bounce them to '/', they never see
  // the invite at all.
  if (pathname.startsWith('/invite')) {
    return supabaseResponse
  }

  // Public payslip pages, the token in the URL is the authentication
  // (resolved server-side against salary_payslip_links). Employees have no
  // account; bouncing them to /login would make every emailed payslip link
  // dead. See app/payslip/[token]/page.tsx.
  if (pathname.startsWith('/payslip')) {
    return supabaseResponse
  }

  // Reset-password is reachable in both auth states. The recovery flow lands
  // here with a fresh session (created by the OTP exchange in /auth/callback)
  // precisely so the user can call supabase.auth.updateUser({ password }). If
  // we bounce authenticated users to '/', the recovery email link silently
  // fails. An already-logged-in user typing /reset-password directly just gets
  // the same "change password" experience as in settings: no security loss.
  if (pathname.startsWith('/reset-password')) {
    return supabaseResponse
  }

  // Email-change confirmations are reachable in both auth states, for the
  // same reason as /reset-password above. The change starts in settings, so
  // the confirmation links are usually clicked while still logged in, and the
  // completing verify mints a fresh session itself. Bouncing authenticated
  // requests off these paths (a) dropped the confirmation click before
  // verifyOtp could consume the token, so the change never completed, and
  // (b) hid the /auth/email-change status page in exactly the success case.
  if (
    pathname.startsWith('/auth/email-change') ||
    (pathname.startsWith('/auth/callback') &&
      request.nextUrl.searchParams.get('type') === 'email_change')
  ) {
    return supabaseResponse
  }

  // Public agent-discovery + API docs surfaces. /llms.txt and /llms-full.txt
  // exist FOR anonymous consumers (the llms.txt convention targets logged-out
  // crawlers and IDE agents), and /docs is the public API documentation the
  // OpenAPI spec and the installable accounted-api skill link to. None of it
  // reads the session. Without this branch every anonymous hit 307-bounced to
  // /login, which silently broke agent discovery on the hosted product
  // (openapi.json only escaped because the proxy matcher skips .json paths).
  // Logged-in users fall through to the same content: no redirect either way.
  if (
    pathname === '/llms.txt' ||
    pathname === '/llms-full.txt' ||
    pathname === '/docs' ||
    pathname.startsWith('/docs/')
  ) {
    return supabaseResponse
  }

  // Public auth routes: allow access
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/sandbox')
  ) {
    // If user is logged in and trying to access auth pages, redirect to the
    // destination the auth page would have sent them to, dashboard otherwise.
    // /login?next=… is set by callers like the MCP OAuth authorize endpoint
    // and by the bounce below; discarding the whole query string here
    // stranded an already-signed-in user on the dashboard instead of the
    // deep link they clicked. Only /login and /register carry `next`;
    // /auth (the PKCE callback) and /sandbox bounce to '/' exactly as before.
    if (user) {
      const carriesDestination =
        pathname.startsWith('/login') || pathname.startsWith('/register')
      const destination = carriesDestination
        ? safeReturnTo(request.nextUrl.searchParams.get('next'), '/')
        : '/'
      return NextResponse.redirect(new URL(destination, request.url))
    }
    return supabaseResponse
  }

  // Protected routes - require authentication
  if (!user) {
    return bounceToAuth(request, '/login')
  }

  // ── Home-domain affinity (WL, founder call 2026-08-05) ──────────────────
  // Every signed-in user has a home domain: byrå team members home on their
  // brand's domain, everyone else on the platform app URL, except a byrå's
  // client users, whose home is the byrå domain their companies live under.
  // On a mismatch the request is redirected to the home domain's root:
  // sessions are per domain, so the user lands on the RIGHT branded login
  // and signs in there ("the domain corrects itself"). This complements the
  // WL-01 signpost, which handles per-company homing INSIDE a domain and
  // stays the answer for multi-domain company rosters. Exemption: byrå
  // staff who also have canonical-homed companies stay put on the canonical
  // host; the signpost handles per-company homing.
  const homeOutcome = await resolveHomeDomainOutcome(
    supabase,
    user.id,
    user.email ?? null,
    request,
  )
  if (homeOutcome.redirectTo) {
    return NextResponse.redirect(homeOutcome.redirectTo)
  }
  if (homeOutcome.cacheOk) {
    supabaseResponse.cookies.set(
      HOME_DOMAIN_OK_COOKIE,
      normalizeHost(request.nextUrl.hostname),
      {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: HOME_DOMAIN_OK_MAX_AGE,
      },
    )
  }

  // /mfa/enroll: gate behind has-password. BankID-only users who reach this
  // page can lock themselves out: Supabase requires AAL2 to change password
  // or unenroll MFA, and AAL2 needs a prior password sign-in. Force them to
  // set a password first. The /account/set-password page does that and routes
  // back here via ?returnTo. Thread the inner returnTo through so the user
  // ends up on their original destination after the full chain completes.
  if (pathname.startsWith('/mfa/enroll')) {
    if (!userHasPassword(user)) {
      const innerReturnTo = request.nextUrl.searchParams.get('returnTo')
      const mfaTarget = `/mfa/enroll${
        innerReturnTo ? `?returnTo=${encodeURIComponent(innerReturnTo)}` : ''
      }`
      return NextResponse.redirect(
        new URL(
          `/account/set-password?returnTo=${encodeURIComponent(mfaTarget)}`,
          request.url,
        ),
      )
    }
    return supabaseResponse
  }

  // Other MFA pages: accessible to authenticated users (AAL1+), skip MFA enforcement
  if (pathname.startsWith('/mfa/')) {
    return supabaseResponse
  }

  // /account/set-password is the escape hatch from the BankID/MFA lockout
  // and must be reachable even when the user has no company yet (e.g. mid-
  // onboarding) and is at AAL1.
  if (pathname.startsWith('/account/set-password')) {
    return supabaseResponse
  }

  // Resolve the active company at most once per request: both the MFA
  // enrollment gate and the company-context block below need it, and the
  // resolution costs DB round trips.
  let resolvedCompany: {
    companyId: string | null
    locale: string | null
    degraded: boolean
  } | null = null
  const resolveCompanyOnce = async () =>
    (resolvedCompany ??= await timed(timing, 'companyMs', () =>
      resolveCompanyForMiddleware(supabase, user.id, request),
    ))

  // MFA enforcement (application-side only, not RLS)
  if (shouldEnforceMfa(user)) {
    const { data: aal } = await timed(timing, 'mfaMs', () =>
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    )

    // User has MFA enrolled but hasn't verified this session → redirect to verify
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
      return bounceToAuth(request, '/mfa/verify')
    }

    // MFA required but user has no factor enrolled yet → force enrollment
    // Skip for users with no companies (still setting up).
    //
    // Only worth asking when the session is NOT at AAL2: reaching AAL2
    // requires having verified a challenge on a verified factor, so the
    // factor list cannot be empty there. auth-js implements listFactors()
    // as a getUser() network round trip, and running it here on every
    // page, RSC and prefetch request for every MFA-verified user was the
    // second Supabase Auth call per request (measured via mw-mfa, PR #1922).
    // The narrow case this defers is a user who unenrols their last factor
    // mid-session: the JWT keeps aal2 until the next token refresh, so the
    // enrolment bounce lands on the refresh instead of the next click.
    if (aal?.currentLevel !== 'aal2') {
      const { companyId: companyIdForMfa } = await resolveCompanyOnce()
      if (companyIdForMfa) {
        const { data: factors } = await timed(timing, 'mfaMs', () =>
          supabase.auth.mfa.listFactors(),
        )
        const hasVerifiedFactor = factors?.totp?.some(f => f.status === 'verified')

        if (!hasVerifiedFactor) {
          return bounceToAuth(request, '/mfa/enroll')
        }
      }
    }
  }

  // Forward the pathname so server layouts can branch on it (e.g. render a
  // no-company shell for /settings/account).
  supabaseResponse.headers.set('x-pathname', pathname)

  // Company context resolution
  const cookieCompanyId = request.cookies.get('gnubok-company-id')?.value
  const { companyId, locale: dbLocale, degraded } = await resolveCompanyOnce()

  // If the cookie pointed at a company we can no longer resolve (e.g.
  // archived), clear it so the browser stops sending it. Never on degraded
  // resolution: a transient query failure must not wipe a valid cookie.
  if (!degraded && cookieCompanyId && cookieCompanyId !== companyId) {
    supabaseResponse.cookies.set('gnubok-company-id', '', { path: '/', maxAge: 0 })
  }

  // Sync the locale cookie from user_preferences. This keeps next-intl's
  // request config (which reads the cookie) consistent with the DB value
  // without forcing every RSC render to query the database itself.
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value
  const effectiveLocale = isLocale(dbLocale) ? dbLocale : DEFAULT_LOCALE
  if (!degraded && cookieLocale !== effectiveLocale) {
    supabaseResponse.cookies.set(LOCALE_COOKIE, effectiveLocale, {
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 365,
    })
  }

  // Routes that stay accessible when the user has no active company.
  // Needed so a user who archived their last company can still delete
  // their account without being trapped on /onboarding forever.
  const isNoCompanyAllowed =
    pathname.startsWith('/onboarding') ||
    pathname.startsWith('/select-company') ||
    pathname.startsWith('/settings/account') ||
    pathname.startsWith('/api/account/') ||
    pathname.startsWith('/api/company')

  // No companies: redirect to the picker if we have BankID enrichment for
  // this user, otherwise the manual wizard. Either way, allow the escape-hatch
  // routes to pass through.
  if (!companyId) {
    if (isNoCompanyAllowed) {
      return supabaseResponse
    }

    // Degraded resolution (a query FAILED, as opposed to returning no rows)
    // means the user's companies are unknown, not absent. Fail open: pass
    // the request through and let the layout's own resolution retry or
    // surface an error. Redirecting here showed fully onboarded users the
    // onboarding wizard again on a transient failure (issue #1053).
    if (degraded) {
      return supabaseResponse
    }

    // Byrå team members (any role: deliberately NOT gated by
    // isCockpitLandingRole even after the 2026-08-27 owner/admin landing
    // gate, because a plain member with zero companies has nowhere else to
    // land) with zero client companies (a fresh byrå) home to the
    // EMPTY cockpit, never to the company onboarding wizard: clients are
    // created from the cockpit, and forcing the wizard here would make a
    // byrå user create a personal company just to get in. Cockpit-shaped
    // paths pass through (the dashboard layout renders its no-company shell);
    // everything else is steered to /byra. API requests pass through so the
    // routes' own guards answer with JSON instead of an HTML redirect.
    // The query runs only in the rare no-company state: zero hot-path cost.
    const { data: byraRows } = await supabase
      .from('team_members')
      .select('role, teams:team_id!inner(kind)')
      .eq('user_id', user.id)
      .eq('teams.kind', 'byra')
    const isByraMember = (byraRows ?? []).length > 0
    if (isByraMember) {
      const isByraNoCompanyAllowed =
        pathname.startsWith('/byra') ||
        pathname.startsWith('/clients') ||
        pathname.startsWith('/companies/new') ||
        pathname.startsWith('/settings') ||
        pathname.startsWith('/api/')
      if (isByraNoCompanyAllowed) {
        return supabaseResponse
      }
      return NextResponse.redirect(new URL('/byra', request.url))
    }

    // Enrichment lives in the user-keyed `bankid_enrichment` table (migration
    // 20260506160000), it cannot live in extension_data, which is
    // company-scoped, and the user has no company yet on this path.
    const { data: enrichmentRow } = await supabase
      .from('bankid_enrichment')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    const destination = enrichmentRow ? '/select-company' : '/onboarding'
    return NextResponse.redirect(new URL(destination, request.url))
  }

  // Set company cookie on the response so downstream requests have it
  supabaseResponse.cookies.set('gnubok-company-id', companyId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })

  // Allow access to onboarding (for adding new companies), select-company, and companies/new
  if (pathname.startsWith('/select-company') || pathname.startsWith('/companies/new') || pathname.startsWith('/onboarding')) {
    return supabaseResponse
  }

  return supabaseResponse
}

async function getSupabaseSessionId(
  supabase: ReturnType<typeof createServerClient>,
): Promise<string | null> {
  if (typeof supabase.auth.getClaims !== 'function') return null

  try {
    const { data } = await supabase.auth.getClaims()
    return typeof data?.claims?.session_id === 'string'
      ? data.claims.session_id
      : null
  } catch (error) {
    console.warn('[middleware] could not resolve Supabase session id', error)
    return null
  }
}

async function signOutTimedOutSession(
  supabase: ReturnType<typeof createServerClient>,
): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' })
  } catch (error) {
    console.warn('[middleware] timed-out session revocation failed', error)
  }
}

function clearAuthMethodHint(
  request: NextRequest,
  response: NextResponse,
): void {
  if (!request.cookies.has(SESSION_AUTH_METHOD_HINT_COOKIE)) return
  request.cookies.delete(SESSION_AUTH_METHOD_HINT_COOKIE)
  response.cookies.set(SESSION_AUTH_METHOD_HINT_COOKIE, '', {
    path: '/',
    maxAge: 0,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

function clearSessionTimeoutCookies(
  request: NextRequest,
  response: NextResponse,
): void {
  if (request.cookies.has(SESSION_TIMEOUT_COOKIE)) {
    request.cookies.delete(SESSION_TIMEOUT_COOKIE)
    response.cookies.set(
      SESSION_TIMEOUT_COOKIE,
      '',
      sessionTimeoutClearCookieOptions(),
    )
  }
  clearAuthMethodHint(request, response)
}

function copyResponseCookies(from: NextResponse, to: NextResponse): void {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
}

function sessionTimeoutResponse(
  request: NextRequest,
  authResponse: NextResponse,
  reason: SessionTimeoutReason,
  method: SessionAuthMethod,
): NextResponse {
  clearSessionTimeoutCookies(request, authResponse)

  if (request.nextUrl.pathname.startsWith('/api')) {
    const response = NextResponse.json(
      {
        error: {
          code: 'SESSION_EXPIRED',
          message: reason === 'idle'
            ? 'Sessionen har upphört på grund av inaktivitet.'
            : 'Sessionen har upphört av säkerhetsskäl.',
          message_en: reason === 'idle'
            ? 'The session expired due to inactivity.'
            : 'The session expired for security reasons.',
          reason,
        },
      },
      { status: 401 },
    )
    response.headers.set(SESSION_TIMEOUT_REASON_HEADER, reason)
    response.headers.set('Cache-Control', 'no-store')
    copyResponseCookies(authResponse, response)
    return response
  }

  const url = new URL('/login', request.url)
  url.searchParams.set('reason', reason)
  url.searchParams.set('method', method)
  const destination = safeReturnTo(
    request.nextUrl.pathname + request.nextUrl.search,
    '/',
  )
  if (destination !== '/') url.searchParams.set('next', destination)

  const response = NextResponse.redirect(url)
  response.headers.set('Cache-Control', 'no-store')
  copyResponseCookies(authResponse, response)
  return response
}

/**
 * Which query parameter each auth page reads its post-auth destination from.
 * /login reads `next` (app/(auth)/login/page.tsx), the MFA pages read
 * `returnTo` (app/(auth)/mfa/verify/page.tsx, app/(auth)/mfa/enroll/page.tsx).
 * Sending the wrong name is a silent no-op, so the mapping is explicit
 * rather than guessed per call site.
 */
const AUTH_DESTINATION_PARAM = {
  '/login': 'next',
  '/mfa/verify': 'returnTo',
  '/mfa/enroll': 'returnTo',
} as const

/**
 * Bounce to an auth page, remembering where the user was heading.
 *
 * Fixes two things the hand-rolled redirects did wrong. (1) Cloning
 * `request.nextUrl` and overwriting only `pathname` carried the ORIGINAL
 * query string onto the auth page: /settings/billing?success=1 arrived as
 * /login?success=1, a stray parameter the login page never asked for. The
 * URL here is built fresh from the request origin, so it holds nothing but
 * the one parameter we set. (2) The destination itself was dropped, so
 * emailed deep links and payment returns landed on the dashboard after
 * sign-in instead of where the user was going.
 *
 * Open-redirect guard: the destination is the CURRENT request's path plus
 * query, run through `safeReturnTo`, which admits same-origin relative paths
 * only. Absolute URLs, protocol-relative `//evil.com`, and the encoded forms
 * that normalise into one are rejected, and a rejected (or absent, or
 * root) destination degrades to a bare bounce with no parameter at all.
 * Nothing attacker-supplied is reflected unvalidated.
 *
 * MFA semantics are untouched: this only decorates the URL of a redirect
 * that was going to happen anyway, on exactly the same conditions. The auth
 * pages navigate to the destination only after the step-up succeeds, and the
 * next request re-runs this same gate regardless.
 */
function bounceToAuth(
  request: NextRequest,
  target: keyof typeof AUTH_DESTINATION_PARAM,
) {
  // Absolute-path reference: replaces path AND clears query/fragment.
  const url = new URL(target, request.url)
  const destination = safeReturnTo(
    request.nextUrl.pathname + request.nextUrl.search,
    '/',
  )
  if (destination !== '/') {
    url.search = `${AUTH_DESTINATION_PARAM[target]}=${encodeURIComponent(destination)}`
  }
  return NextResponse.redirect(url)
}

/**
 * Hosts that carry no brand affinity: local dev and direct Vercel
 * deployment URLs must never bounce a signed-in user to a product domain.
 */
function isAffinityExemptHost(host: string): boolean {
  return (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.vercel.app') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  )
}

/**
 * Decide whether this signed-in request sits on the user's home domain.
 *
 * Rules (founder call 2026-08-05):
 *   1. A byrå team member's home is their brand's domain: any other product
 *      host (a foreign byrå domain OR the platform domain) redirects there,
 *      EXCEPT on the canonical platform host when the member also has a
 *      company homed there (a company whose team has no brand): they stay,
 *      and the WL-01 signpost handles per-company homing.
 *   2. A non-member on a brand domain redirects to the platform app URL,
 *      UNLESS one of their companies is homed under that brand's team (the
 *      byrå's own client users log in on the byrå domain).
 *   3. Everyone else stays put.
 *
 * `cacheOk` marks a positive "this is home" verdict, cached in a host-scoped
 * cookie by the caller. Query failures fail open with no caching, so a
 * transient error neither locks anyone out nor sticks for a TTL window.
 */
async function resolveHomeDomainOutcome(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  userEmail: string | null,
  request: NextRequest,
): Promise<{ redirectTo: URL | null; cacheOk: boolean }> {
  const stay = { redirectTo: null, cacheOk: false }
  const host = normalizeHost(request.nextUrl.hostname)
  if (isAffinityExemptHost(host)) return stay
  if (request.cookies.get(HOME_DOMAIN_OK_COOKIE)?.value === host) return stay

  // Rule 1: the user's own byrå brand domains (RLS: members read their brand).
  const { data: byraRows, error: byraError } = await supabase
    .from('team_members')
    .select('teams:team_id!inner(kind, brands(domain))')
    .eq('user_id', userId)
    .eq('teams.kind', 'byra')
  if (byraError) {
    console.error('[middleware] home-domain byrå lookup failed', byraError)
    return stay
  }

  const byraDomains: string[] = []
  for (const row of byraRows ?? []) {
    const teams = (row as { teams?: { brands?: unknown } | null }).teams
    const brands = teams?.brands
    // One brand per team (brands.team_id unique): PostgREST returns an
    // object, but tolerate the array shape too.
    const list = Array.isArray(brands) ? brands : brands ? [brands] : []
    for (const entry of list) {
      const domain = (entry as { domain?: unknown }).domain
      if (typeof domain === 'string' && domain) byraDomains.push(normalizeHost(domain))
    }
  }
  if (byraDomains.length > 0) {
    if (byraDomains.includes(host)) return { redirectTo: null, cacheOk: true }

    // Exemption: a byrå member who ALSO belongs to a company homed on the
    // canonical domain (its team has no brand, or no team at all) must be
    // able to reach that company somewhere, and the canonical host is its
    // only home. Redirecting them off canonical made their own company
    // deterministically unreachable: on the brand host it renders as a
    // non-clickable signpost pointing right back at canonical. So on the
    // canonical host, stay when such a company exists (host-stable verdict,
    // so it is cacheable); a foreign brand host still redirects, since
    // nothing of the user's is homed there. Cost: one extra query, only for
    // byrå members on the canonical host without a fresh home-ok cookie.
    const canonicalHost = normalizeHost(
      new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://app.gnubok.se').hostname,
    )
    if (host === canonicalHost) {
      const { data: companyRows, error: companyError } = await supabase
        .from('company_members')
        .select('companies!inner(team_id, teams(brands(id)))')
        .eq('user_id', userId)
      if (companyError) {
        console.error(
          '[middleware] home-domain canonical-company lookup failed',
          companyError,
        )
        return stay
      }
      if ((companyRows ?? []).some(rowHasCanonicalHomedCompany)) {
        return { redirectTo: null, cacheOk: true }
      }
    }
    // Carry the original path and query across the hop so deep links (invite
    // accepts, direct object URLs) survive the domain correction.
    return {
      redirectTo: new URL(
        `${request.nextUrl.pathname}${request.nextUrl.search}`,
        `https://${byraDomains[0]}`,
      ),
      cacheOk: false,
    }
  }

  // Rule 2: not a byrå member, so only a brand host can be foreign.
  const hostBrand = await resolveBrandByHost(host)
  if (!hostBrand) return { redirectTo: null, cacheOk: true }

  const { data: clientRows, error: clientError } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(team_id)')
    .eq('user_id', userId)
    .eq('companies.team_id', hostBrand.teamId)
    .limit(1)
  if (clientError) {
    console.error('[middleware] home-domain client lookup failed', clientError)
    return stay
  }
  if ((clientRows ?? []).length > 0) return { redirectTo: null, cacheOk: true }

  // A signup-allowlisted email stays on the brand host even before any
  // membership exists: the partner owner between allowlisted signup and team
  // provisioning. Without this the layout-level exemption in
  // resolveBrandDomainBounce (lib/auth/brand-signup-gate.ts) is unreachable,
  // because this redirect runs first. Fail-closed lookup: an allowlist query
  // error reads as "not allowlisted" and falls through to the platform
  // redirect, which is the pre-existing behavior.
  if (userEmail && (await isEmailOnBrandAllowlist(hostBrand.id, userEmail))) {
    return { redirectTo: null, cacheOk: true }
  }

  const platformUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://app.gnubok.se')
  if (normalizeHost(platformUrl.hostname) === host) return { redirectTo: null, cacheOk: true }
  // Preserve path + query for the same deep-link reason as the byrå hop.
  return {
    redirectTo: new URL(
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
      platformUrl.origin,
    ),
    cacheOk: false,
  }
}

/**
 * Whether a company_members row (carrying the companies → teams → brands
 * embed) points at a company homed on the canonical domain: no team at all,
 * or a team without a brands row. The brand null-check happens HERE in JS on
 * purpose: a PostgREST `.is()` filter on an embedded resource does not
 * filter the parent rows, so filtering server-side would silently match
 * every membership. Embeds arrive as object or array depending on the
 * relationship shape, so both are tolerated (same as the byraRows parsing).
 */
function rowHasCanonicalHomedCompany(row: unknown): boolean {
  const companies = (row as { companies?: unknown }).companies
  const companyList = Array.isArray(companies) ? companies : companies ? [companies] : []
  for (const company of companyList) {
    const teams = (company as { teams?: unknown }).teams
    if (!teams) return true
    const teamList = Array.isArray(teams) ? teams : [teams]
    for (const team of teamList) {
      const brands = (team as { brands?: unknown }).brands
      const brandList = Array.isArray(brands) ? brands : brands ? [brands] : []
      if (brandList.length === 0) return true
    }
  }
  return false
}

/**
 * Resolve the active company for the authenticated user.
 *
 * Resolution: user_preferences → first non-archived membership.
 *
 * `user_preferences.active_company_id` is the authoritative source for
 * the active company on both the Next.js and Postgres RLS side. The
 * `gnubok-company-id` cookie is still refreshed for legacy read paths
 * but it is no longer READ here, because RLS (via
 * `current_active_company_id()`) cannot see cookies: so letting the
 * cookie override the database would re-introduce the divergence this
 * entire migration exists to fix.
 *
 * When we fall back to "first membership" (no user_preferences row yet),
 * we also upsert user_preferences so subsequent RLS lookups agree with
 * us without needing the fallback scan.
 *
 * RPC-first: `resolve_active_company()` collapses the whole resolution into
 * one round trip and is semantically identical to both the query path below
 * and `current_active_company_id()` (what RLS reads). `used_fallback` is
 * true exactly when the preference was missing, null, or stale, which is
 * exactly the condition under which the query path writes the resolved
 * company back to user_preferences: the write-back behavior is preserved.
 * Falls back to the query path on PGRST202 (self-hosted instance not
 * migrated yet, or a deploy racing the branch merge).
 *
 * Cannot use lib/company/context.ts because middleware runs on Edge.
 */
async function resolveCompanyForMiddleware(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  _request: NextRequest
): Promise<{ companyId: string | null; locale: string | null; degraded: boolean }> {
  const { data, error } = await supabase.rpc('resolve_active_company')

  if (error) {
    if (error.code === 'PGRST202') {
      // Function not deployed here: use the query path.
      return resolveCompanyForMiddlewareViaQueries(supabase, userId, _request)
    }
    // Issue #1053: a FAILED call degrades (fail open), never reads as "no
    // companies". locale null is fine because the degraded flag already
    // suppresses the locale-cookie sync at the call site.
    console.error('[middleware] resolve_active_company rpc failed', error)
    return { companyId: null, locale: null, degraded: true }
  }

  const row = Array.isArray(data) ? data[0] : data
  if (!row) {
    // Zero rows = NULL auth.uid(); impossible for the cookie-auth middleware
    // client, so treat as degraded rather than redirecting to onboarding.
    console.error('[middleware] resolve_active_company returned no row for authenticated user')
    return { companyId: null, locale: null, degraded: true }
  }

  if (row.company_id && row.used_fallback) {
    // Write the fallback back to user_preferences so future RLS lookups see
    // the same active company without needing the fallback scan. Non-fatal
    // on failure: resolution already succeeded, but log it so silent
    // persistence failures (#701) are observable.
    const { error: writeBackError } = await supabase
      .from('user_preferences')
      .upsert(
        { user_id: userId, active_company_id: row.company_id },
        { onConflict: 'user_id' }
      )
    if (writeBackError) {
      console.error('[middleware] active company write-back failed', writeBackError)
    }
  }

  return {
    companyId: row.company_id ?? null,
    locale: row.locale ?? null,
    degraded: false,
  }
}

/**
 * Query-path resolution: the pre-RPC implementation, kept verbatim as the
 * fallback for resolveCompanyForMiddleware (see the fallback conditions
 * there).
 */
async function resolveCompanyForMiddlewareViaQueries(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  _request: NextRequest
): Promise<{ companyId: string | null; locale: string | null; degraded: boolean }> {
  // 1. user_preferences (authoritative) + first membership, fetched in
  // parallel: the fallback query result doubles as validation when the
  // preferred company happens to be the first membership, which is the
  // common single-company case, so most requests pay one round trip
  // instead of two sequential ones.
  const [prefsRes, firstRes] = await Promise.all([
    supabase
      .from('user_preferences')
      .select('active_company_id, locale')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])

  const prefs = prefsRes.data
  const firstCompany = firstRes.data
  const locale = (prefs?.locale as string | undefined) ?? null

  // A FAILED query (as opposed to one returning no rows) means the user's
  // companies are unknown right now, not absent: flag it so the caller
  // fails open instead of redirecting to onboarding or clearing cookies
  // (issue #1053). Middleware cannot throw usefully, hence a flag.
  if (prefsRes.error || firstRes.error) {
    console.error(
      '[middleware] company resolution query failed',
      prefsRes.error ?? firstRes.error
    )
    return { companyId: null, locale, degraded: true }
  }

  if (prefs?.active_company_id) {
    if (prefs.active_company_id === firstCompany?.company_id) {
      return { companyId: firstCompany.company_id, locale, degraded: false }
    }

    const { data: membership, error: membershipError } = await supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('company_id', prefs.active_company_id)
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .maybeSingle()

    // A failed validation must not silently switch the user onto their
    // first membership (wrong company for consultants): degrade instead.
    if (membershipError) {
      console.error('[middleware] company preference validation failed', membershipError)
      return { companyId: null, locale, degraded: true }
    }

    if (membership) return { companyId: membership.company_id, locale, degraded: false }
  }

  // 2. Fallback: first non-archived membership (already fetched above)
  if (!firstCompany) return { companyId: null, locale, degraded: false }

  // Write the fallback back to user_preferences so future RLS lookups
  // see the same active company without needing this fallback scan.
  // Non-fatal on failure: resolution for this request already succeeded,
  // the write-back is an optimization, but log it so silent persistence
  // failures (#701) are observable.
  const { error: writeBackError } = await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, active_company_id: firstCompany.company_id },
      { onConflict: 'user_id' }
    )

  if (writeBackError) {
    console.error('[middleware] active company write-back failed', writeBackError)
  }

  return { companyId: firstCompany.company_id, locale, degraded: false }
}
