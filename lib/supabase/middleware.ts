import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { shouldEnforceMfa } from '@/lib/auth/mfa'
import { apiPathSkipsMfaGate } from '@/lib/auth/api-mfa-gate'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/i18n/config'
import { userHasPassword } from '@/lib/auth/has-password'

export async function updateSession(request: NextRequest) {
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
  } = await supabase.auth.getUser()

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
      request.headers.get('authorization') !== null,
    )
    if (!skipMfaGate && user && shouldEnforceMfa(user)) {
      const { data: aal } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
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

  // Public auth routes: allow access
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/sandbox')
  ) {
    // If user is logged in and trying to access auth pages, redirect to dashboard
    if (user) {
      return NextResponse.redirect(new URL('/', request.url))
    }
    return supabaseResponse
  }

  // Protected routes - require authentication
  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
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

  // MFA enforcement (application-side only, not RLS)
  if (shouldEnforceMfa(user)) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

    // User has MFA enrolled but hasn't verified this session → redirect to verify
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
      return NextResponse.redirect(new URL('/mfa/verify', request.url))
    }

    // MFA required but user has no factor enrolled yet → force enrollment
    // Skip for users with no companies (still setting up)
    const { companyId: companyIdForMfa } = await resolveCompanyForMiddleware(supabase, user.id, request)
    if (companyIdForMfa) {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const hasVerifiedFactor = factors?.totp?.some(f => f.status === 'verified')

      if (!hasVerifiedFactor) {
        return NextResponse.redirect(new URL('/mfa/enroll', request.url))
      }
    }
  }

  // Forward the pathname so server layouts can branch on it (e.g. render a
  // no-company shell for /settings/account).
  supabaseResponse.headers.set('x-pathname', pathname)

  // Company context resolution
  const cookieCompanyId = request.cookies.get('gnubok-company-id')?.value
  const { companyId, locale: dbLocale } = await resolveCompanyForMiddleware(supabase, user.id, request)

  // If the cookie pointed at a company we can no longer resolve (e.g.
  // archived), clear it so the browser stops sending it.
  if (cookieCompanyId && cookieCompanyId !== companyId) {
    supabaseResponse.cookies.set('gnubok-company-id', '', { path: '/', maxAge: 0 })
  }

  // Sync the locale cookie from user_preferences. This keeps next-intl's
  // request config (which reads the cookie) consistent with the DB value
  // without forcing every RSC render to query the database itself.
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value
  const effectiveLocale = isLocale(dbLocale) ? dbLocale : DEFAULT_LOCALE
  if (cookieLocale !== effectiveLocale) {
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
 * Cannot use lib/company/context.ts because middleware runs on Edge.
 */
async function resolveCompanyForMiddleware(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  _request: NextRequest
): Promise<{ companyId: string | null; locale: string | null }> {
  // 1. user_preferences (authoritative)
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_company_id, locale')
    .eq('user_id', userId)
    .maybeSingle()

  const locale = (prefs?.locale as string | undefined) ?? null

  if (prefs?.active_company_id) {
    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('company_id', prefs.active_company_id)
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .maybeSingle()

    if (membership) return { companyId: membership.company_id, locale }
  }

  // 2. Fallback: first non-archived membership by created_at
  const { data: firstCompany } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', userId)
    .is('companies.archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!firstCompany) return { companyId: null, locale }

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

  return { companyId: firstCompany.company_id, locale }
}
