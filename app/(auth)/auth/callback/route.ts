import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const next = searchParams.get('next') ?? '/'

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

  let authenticated = false

  // Handle PKCE flow (code exchange)
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    authenticated = !error
  }
  // Handle token hash flow (email verification / magic link)
  else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      type: type as 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email',
    })
    authenticated = !error
  }

  if (authenticated) {
    let redirectPath = next

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

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      // Check MFA status: redirect to verify if factor is enrolled but session is AAL1
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
        const response = NextResponse.redirect(new URL('/mfa/verify', origin))
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

      // Ensure user has a silent team (for new signups and existing users without one)
      const { data: teamMembership } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle()

      if (!teamMembership) {
        // Create team via service client (RPC requires auth.uid() which isn't available here)
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
      }

      // Always redirect to dashboard: it handles zero-company and incomplete states
      redirectPath = '/'
    }

    // Create redirect and explicitly set auth cookies on the response
    const response = NextResponse.redirect(new URL(redirectPath, origin))
    for (const { name, value, options } of pendingCookies) {
      response.cookies.set({ name, value, ...options })
    }
    // Keep the invite cookie alive so the onboarding page fallback can
    // retry acceptance (only clear it when successfully processed above).
    return response
  }

  // Authentication failed: redirect to login with error
  return NextResponse.redirect(new URL('/login?error=auth_error', origin))
}
