import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import { INVITE_COOKIE_NAME } from '@/lib/auth/consume-invite-cookie'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { resolveLandingDestination } from '@/lib/company/landing-server'
import { acceptPendingTeamInviteByToken } from '@/lib/company/pending-invites'

/**
 * The one `next` destination this callback honours for a fresh session: the
 * MCP OAuth consent page. A signup that started from an MCP client's Connect
 * popup (issue #1814) confirms its e-mail or completes Google OAuth here, and
 * has to land back on consent instead of the dashboard. Consent handles the
 * zero-company state itself, which is why this is safe where an arbitrary
 * deep link would not be (a brand-new account has no membership to spend a
 * deep link on). Same-origin only, via safeReturnTo.
 */
function oauthResumePath(next: string): string | null {
  const safe = safeReturnTo(next, '/')
  return safe.startsWith('/api/mcp-oauth/authorize?') ? safe : null
}

/**
 * Mirror of hasForeignCredential in extensions/general/tic/lib/bankid-pending.ts
 * (core cannot import from extensions). A non-email identity (Google) or a
 * password the user set themselves (`has_password: true`, written only by
 * POST /api/account/password) means somebody proved ownership of the address
 * by other means than the BankID signup's confirmation mail.
 */
function hasForeignCredential(user: {
  identities?: Array<{ provider: string }>
  app_metadata?: Record<string, unknown>
}): boolean {
  if ((user.identities ?? []).some((identity) => identity.provider !== 'email')) return true
  return user.app_metadata?.has_password === true
}

/**
 * Pending BankID identities (security audit 2026-09, account pre-hijacking).
 *
 * A BankID signup (extensions/general/tic, POST /bankid/complete) creates the
 * auth user with the typed address UNCONFIRMED, a bankid_identities row with
 * email_verified_at NULL, and app_metadata.bankid_pending instead of
 * bankid_linked. The confirmation mail it sends lands here, and this is the
 * one place that promotes the identity: email_verified_at = now(),
 * bankid_linked = true (the MFA exemption in lib/auth/mfa.ts), bankid_pending
 * removed. Until then BankID login refuses the identity.
 *
 * Promotion is refused, and the pending link revoked instead, when the account
 * was adopted through another credential in the meantime: this link is a
 * password reset (type=recovery, "forgot password" on the address), or the
 * user already carries a non-email identity (Google) or a password they set
 * themselves. In each case the real owner of the address proved it by other
 * means, and the BankID holder who typed that address must not end up with a
 * login into their account.
 *
 * Gated on the bankid_pending flag so the ordinary confirmation and recovery
 * paths cost nothing extra. Failures are logged and never block the redirect:
 * a pending identity simply stays pending, which is the safe state.
 */
/**
 * The session_id claim of a GoTrue access token, or null. Used to keep the
 * address owner's own fresh session when every other session of the account
 * is revoked; a token that cannot be read simply keeps nothing.
 */
function sessionIdFromAccessToken(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null
  const parts = accessToken.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      session_id?: unknown
    }
    return typeof payload.session_id === 'string' ? payload.session_id : null
  } catch {
    return null
  }
}

async function reconcilePendingBankIdIdentity(
  user: { id: string; app_metadata?: Record<string, unknown> },
  type: string,
  keepSessionId: string | null = null,
): Promise<void> {
  if (user.app_metadata?.bankid_pending !== true) return

  try {
    const service = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { cookies: { getAll: () => [], setAll: () => {} } }
    )

    const { data: pending, error: lookupError } = await service
      .from('bankid_identities')
      .select('id')
      .eq('user_id', user.id)
      .is('email_verified_at', null)
      .maybeSingle()
    if (lookupError) {
      console.error('[auth/callback] pending BankID lookup failed:', lookupError.message)
      return
    }

    // Fresh, authoritative copy: identities and app_metadata as of now.
    const { data: userData, error: userError } = await service.auth.admin.getUserById(user.id)
    const current = userData?.user
    if (userError || !current) {
      console.error('[auth/callback] pending BankID user lookup failed:', userError?.message)
      return
    }
    const prior = current.app_metadata ?? {}

    if (!pending || type === 'recovery' || hasForeignCredential(current)) {
      // Adopted, or nothing left to promote: drop the unverified link and the
      // flag. bankid_linked is untouched (a pending signup never set it).
      // null removes the key under GoTrue's merge semantics and is falsy if
      // app_metadata is ever replaced wholesale instead.
      if (pending) {
        const { error: deleteError } = await service
          .from('bankid_identities')
          .delete()
          .eq('user_id', user.id)
          .is('email_verified_at', null)
        if (deleteError) {
          console.error('[auth/callback] pending BankID revoke failed:', deleteError.message)
          return
        }
        console.warn(
          '[auth/callback] pending BankID identity revoked: account adopted through another credential',
          { userId: user.id, type },
        )
        // BankID instant login: the holder may be signed in right now. The
        // revoke only bites once their sessions die too; GoTrue checks the
        // session_id of every access token, so this cuts them off at once.
        // The address owner's own session (this request) is the one kept.
        const { error: revokeError } = await service.rpc('revoke_user_sessions', {
          p_user_id: user.id,
          p_keep_session_id: keepSessionId,
        })
        if (revokeError) {
          console.error('[auth/callback] session revoke after pending BankID revoke failed:', revokeError.message)
        }
      }
      await service.auth.admin.updateUserById(user.id, {
        app_metadata: { ...prior, bankid_pending: null },
      })
      return
    }

    // The click proves the address for the BankID holder who typed it.
    const { error: promoteError } = await service
      .from('bankid_identities')
      .update({ email_verified_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('email_verified_at', null)
    if (promoteError) {
      console.error('[auth/callback] pending BankID promotion failed:', promoteError.message)
      return
    }
    await service.auth.admin.updateUserById(user.id, {
      app_metadata: { ...prior, bankid_linked: true, bankid_pending: null },
    })
  } catch (err) {
    console.error('[auth/callback] pending BankID reconciliation failed:', err)
  }
}

type EmailChangeStatus = 'partial' | 'done' | 'failed'

/**
 * Status of a stock (GoTrue-hosted) email-change link that came back through
 * redirect_to. GoTrue puts the outcome in the query for PKCE links: a
 * half-completed secure change carries ?message=, a dead link ?error= /
 * ?error_code=, and the completing click ?code=. Implicit-flow links put the
 * same outcome in the URL fragment, which never reaches the server; the
 * fallback reads the user's pending state instead of guessing.
 */
async function resolveStockEmailChangeStatus(
  supabase: ReturnType<typeof createServerClient>,
  searchParams: URLSearchParams,
  code: string | null,
): Promise<EmailChangeStatus> {
  if (searchParams.get('error') || searchParams.get('error_code')) return 'failed'
  if (searchParams.get('message')) return 'partial'
  if (code) {
    // GoTrue mints the code only after the completing verify has flipped the
    // address, so the change is done whatever happens to the exchange. It
    // fails when the link is opened in a browser without the PKCE verifier
    // cookie (a phone mail app); the status page then just has no session
    // to land, which must not be reported as a failed change.
    await supabase.auth.exchangeCodeForSession(code)
    return 'done'
  }
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return 'failed'
  return user.new_email ? 'partial' : 'done'
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const next = searchParams.get('next') ?? '/'
  const resumeOAuth = oauthResumePath(next)

  // Collect cookies that Supabase sets during auth so we can
  // explicitly forward them on the redirect response.
  const pendingCookies: { name: string; value: string; options: Record<string, unknown> }[] = []

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          pendingCookies.length = 0
          cookiesToSet.forEach((cookie) => {
            // Mirror the cookie into request.cookies so subsequent getAll()
            // calls within this request lifecycle return the updated values
            // (matches the pattern used in proxy.ts).
            request.cookies.set(cookie.name, cookie.value)
            pendingCookies.push(cookie)
          })
        },
      },
    }
  )

  // Stock GoTrue email-change links (no Send Email hook) verify on the GoTrue
  // host and come back here through redirect_to instead of carrying a
  // token_hash: with secure email change the first of the two confirmations
  // arrives as ?message=..., a dead link as ?error=..., and the completing
  // click as ?code= (PKCE). /api/account/email stamps flow=email_change on
  // emailRedirectTo so all three land on the status page like the token_hash
  // branch below. Before this they fell through to the login bounce with no
  // message, which reads as "det funkar inte" and invites a retry that voids
  // the mails just sent.
  if (searchParams.get('flow') === 'email_change' && !token_hash) {
    const status = await resolveStockEmailChangeStatus(supabase, searchParams, code)
    const response = NextResponse.redirect(
      new URL(`/auth/email-change?status=${status}`, origin),
    )
    for (const { name, value, options } of pendingCookies) {
      response.cookies.set({ name, value, ...options })
    }
    return response
  }

  let authenticated = false

  // Handle PKCE flow (code exchange)
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    authenticated = !error
    // A Google sign-in on an address a pending BankID signup typed is the
    // address owner adopting the account (GoTrue links the Google identity
    // by verified e-mail). The pending BankID link must go, and with it the
    // BankID holder's sessions; only this exchange's session survives.
    if (!error && data?.user) {
      await reconcilePendingBankIdIdentity(
        data.user,
        'oauth',
        sessionIdFromAccessToken(data.session?.access_token),
      )
    }
  }
  // Handle token hash flow (email verification / magic link)
  else if (token_hash && type) {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash,
      type: type as 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email',
    })

    // Email change never lands silently: with secure email change enabled the
    // user must confirm from BOTH addresses, and dropping them on the
    // dashboard (or login) with no message is exactly how a half-completed
    // change reads as "det funkar inte". The status page tells them whether
    // one click remains, the change is complete, or the link was dead.
    // Completing the second confirmation returns a session; the first (or a
    // click from a logged-out mailbox) does not, which is what separates
    // 'done' from 'partial'. Cookies are forwarded so a minted session
    // survives the redirect.
    if (type === 'email_change') {
      const status = error ? 'failed' : data?.session ? 'done' : 'partial'
      const response = NextResponse.redirect(
        new URL(`/auth/email-change?status=${status}`, origin),
      )
      for (const { name, value, options } of pendingCookies) {
        response.cookies.set({ name, value, ...options })
      }
      return response
    }

    // A BankID signup proves its address through this very link; a password
    // reset on that address proves the opposite. Runs before the recovery
    // early-return below so both outcomes are handled here.
    if (!error && data?.user) {
      await reconcilePendingBankIdIdentity(
        data.user,
        type,
        sessionIdFromAccessToken(data.session?.access_token),
      )
    }

    authenticated = !error
  }

  if (authenticated) {
    let redirectPath = next
    // Set once a byrå-team invite is accepted below, so the final response
    // clears the invite cookie instead of leaving it for a redundant retry.
    let inviteConsumed = false

    // Password recovery flow: the user just exchanged a recovery token, so they
    // have a fresh session whose only purpose is to call updateUser({ password })
    // on /reset-password. Skip onboarding / team setup / dashboard redirect.
    // The token-hash flow signals this via type=recovery; PKCE has no type, so
    // also gate on next === '/reset-password' (only the reset request sets it).
    if (type === 'recovery' || next === '/reset-password') {
      const response = NextResponse.redirect(new URL('/reset-password', origin))
      for (const { name, value, options } of pendingCookies) {
        response.cookies.set({ name, value, ...options })
      }
      return response
    }

    // Admin-provisioned invite (auth.admin.inviteUserByEmail, used when the
    // installation runs with signups disabled): the invited user now has a
    // verified session but no password. Reuse the recovery surface so they
    // set one before anything else. The company invite token travels in
    // `next` (/invite/<token>); persist it as the pre-auth invite cookie so
    // the reset-password invite handoff accepts the membership right after
    // the password is saved.
    if (type === 'invite') {
      const response = NextResponse.redirect(new URL('/reset-password', origin))
      for (const { name, value, options } of pendingCookies) {
        response.cookies.set({ name, value, ...options })
      }
      const inviteTokenMatch = next.match(/^\/invite\/([A-Za-z0-9_-]+)$/)
      if (inviteTokenMatch) {
        // Mirrors buildInviteCookie in app/invite/[token]/page.tsx: readable
        // by the client auth surfaces (not httpOnly), lifetime matching the
        // 7-day invite TTL that the server re-checks on every acceptance.
        response.cookies.set(INVITE_COOKIE_NAME, inviteTokenMatch[1], {
          path: '/',
          httpOnly: false,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60,
        })
      }
      return response
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      // Check MFA status: redirect to verify if factor is enrolled but session is AAL1
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
        const verifyUrl = new URL('/mfa/verify', origin)
        if (resumeOAuth) verifyUrl.searchParams.set('returnTo', resumeOAuth)
        const response = NextResponse.redirect(verifyUrl)
        for (const { name, value, options } of pendingCookies) {
          response.cookies.set({ name, value, ...options })
        }
        return response
      }

      // Check for pending invite token (set by invite page before redirecting to register)
      const inviteToken = request.cookies.get('gnubok-invite-token')?.value
      if (inviteToken) {
        try {
          const tokenHash = hashInviteToken(inviteToken)

          // Use the service role client to bypass RLS for invite acceptance
          const serviceClient = createServerClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { cookies: { getAll: () => [], setAll: () => {} } }
          )

          // Look up company invitation
          const { data: invite } = await serviceClient
            .from('company_invitations')
            .select('id, company_id, email, role, status, expires_at')
            .eq('token_hash', tokenHash)
            .single()

          if (
            invite &&
            invite.status === 'pending' &&
            new Date(invite.expires_at) > new Date() &&
            user.email?.toLowerCase() === invite.email.toLowerCase()
          ) {
            // Add user to company
            await serviceClient.from('company_members').insert({
              company_id: invite.company_id,
              user_id: user.id,
              role: invite.role,
              source: 'direct',
            })

            // Set active company. Non-fatal on failure (middleware falls
            // back to the membership created above) but log so silent
            // persistence failures (#701) are observable.
            const { error: prefError } = await serviceClient.from('user_preferences').upsert({
              user_id: user.id,
              active_company_id: invite.company_id,
            }, { onConflict: 'user_id' })

            if (prefError) {
              console.error('[auth/callback] failed to set active company', prefError)
            }

            // Mark invite as accepted
            await serviceClient
              .from('company_invitations')
              .update({ status: 'accepted' })
              .eq('id', invite.id)

            // Invited user goes straight to dashboard: no onboarding needed
            redirectPath = '/'

            // Clear invite cookie and set company cookie on response
            const response = NextResponse.redirect(new URL(redirectPath, origin))
            for (const { name, value, options } of pendingCookies) {
              response.cookies.set({ name, value, ...options })
            }
            response.cookies.set('gnubok-company-id', invite.company_id, {
              path: '/',
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
              maxAge: 60 * 60 * 24 * 365,
            })
            response.cookies.delete('gnubok-invite-token')
            return response
          }
        } catch (err) {
          console.error('[auth/callback] invite acceptance failed:', err)
          // Fall through to normal onboarding check
        }
      }

      // Byrå-TEAM invite: the company-invite block above only knows
      // company_invitations, so a byrå staffer's invite was accepted by no
      // server path before landing resolved, and they were funneled to
      // /onboarding as a first-timer. Accept it here, BEFORE the silent-team
      // check (so no stray "Personal" team is minted) and BEFORE landing
      // resolves, so resolveLandingDestination sees the byrå membership and
      // sends an owner/admin to /clients. Company-invite and non-invite flows
      // are untouched. On success the cookie is cleared on the final response;
      // otherwise it survives for the /onboarding + /select-company retry.
      if (inviteToken && !inviteConsumed) {
        try {
          const outcome = await acceptPendingTeamInviteByToken(
            { id: user.id, email: user.email },
            inviteToken,
          )
          if (outcome.status === 'accepted' || outcome.status === 'already_member') {
            inviteConsumed = true
          }
        } catch (err) {
          console.error('[auth/callback] team invite acceptance failed:', err)
        }
      }

      // Ensure user has a silent team (for new signups and existing users without one)
      const { data: teamMembership } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle()

      if (!teamMembership) {
        // Create team via service client (RPC requires auth.uid() which isn't available here).
        // Non-fatal: a failure here must not turn a successfully confirmed session into a
        // 500 that reads as "signup verification failed". The dashboard / onboarding path
        // recreates the silent team when it is missing, so log and continue.
        try {
          const serviceClient = createServerClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { cookies: { getAll: () => [], setAll: () => {} } }
          )

          const teamId = crypto.randomUUID()
          await serviceClient.from('teams').insert({
            id: teamId,
            name: 'Personal',
            created_by: user.id,
          })
          await serviceClient.from('team_members').insert({
            team_id: teamId,
            user_id: user.id,
            role: 'owner',
          })
        } catch (err) {
          console.error('[auth/callback] silent team creation failed:', err)
        }
      }

      // Redirect to the dashboard (it handles zero-company and incomplete
      // states), unless the session was created to resume an MCP OAuth
      // consent flow: that page handles the zero-company state too. With no
      // explicit destination, byrå staff on their byrå's home domain land in
      // the cockpit instead (WL-14): this callback is the OAuth/magic-link
      // twin of the login page's resolvePostLoginDestination call, covering
      // only AAL1 sessions (MFA-enrolled users exited to /mfa/verify above,
      // which applies the same rule). Any failure degrades to '/'.
      if (resumeOAuth) {
        redirectPath = resumeOAuth
      } else {
        try {
          const host =
            request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
          redirectPath = await resolveLandingDestination(supabase, user.id, host)
        } catch (err) {
          console.error('[auth/callback] landing resolution failed:', err)
          redirectPath = '/'
        }
      }
    }

    // Create redirect and explicitly set auth cookies on the response
    const response = NextResponse.redirect(new URL(redirectPath, origin))
    for (const { name, value, options } of pendingCookies) {
      response.cookies.set({ name, value, ...options })
    }
    // Keep the invite cookie alive so the /onboarding and /select-company
    // pages can retry acceptance via acceptPendingInviteByToken, UNLESS a team
    // invite was just accepted above (then the membership exists and a retry
    // would only 409). The company-invite success path returns earlier and
    // clears the cookie itself.
    if (inviteConsumed) {
      response.cookies.delete('gnubok-invite-token')
    }
    return response
  }

  // Authentication failed: redirect to login with error. Forward a coarse
  // flow hint so the login page can show the right copy: a failed signup
  // confirmation must not be framed as a failed password reset. On the PKCE
  // (?code=) path there is no `type`, so recovery is identified by the
  // next=/reset-password marker that resetPasswordForEmail sets, and OAuth
  // by the flow=oauth marker that OAuthButton puts in redirectTo 
  // (provider denials arrive here with ?error and no code); everything else 
  // defaults to the signup/confirmation framing.
  const failedFlow =
    searchParams.get('flow') === 'oauth'
      ? 'oauth'
      : type === 'recovery' || next === '/reset-password'
        ? 'recovery'
        : 'signup'
  const loginUrl = new URL('/login', origin)
  loginUrl.searchParams.set('error', 'auth_error')
  loginUrl.searchParams.set('flow', failedFlow)
  return NextResponse.redirect(loginUrl)
}
