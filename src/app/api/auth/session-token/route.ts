import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' } as const

function noStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE)) response.headers.set(name, value)
  return response
}

/**
 * GET /api/auth/session-token
 *
 * Hands the browser the access token of the server-held session, for the
 * browser Supabase client's direct PostgREST, Storage and Realtime calls
 * (lib/supabase/client.ts). The session cookie is HttpOnly (CASA 2.3.1 /
 * 2.3.2), so this is the only way a page script learns a token, and it never
 * learns the refresh token.
 *
 * Same gates as every other API route, so the browser never holds a token a
 * normal route would refuse: the proxy has already run getUser() (revocation
 * check, and a refresh when the token is within 90 s of expiry, which
 * rewrites the cookies), the session-timeout check and the MFA gate by the
 * time this runs; requireAuth() then verifies the token and enforces AAL2
 * where MFA applies. 401 without a session, 403 below the required level.
 *
 * Not wrapped in withRouteContext: the token is needed before a company
 * exists (onboarding reads through the browser client too), and nothing
 * here is company-scoped. requireAuth() is the same MFA-enforcing guard.
 */
export async function GET(): Promise<NextResponse> {
  const auth = await requireAuth()
  if (auth.error) return noStore(auth.error)

  const {
    data: { session },
  } = await auth.supabase.auth.getSession()
  const accessToken = session?.access_token
  const expiresAt = session?.expires_at
  if (!accessToken || typeof expiresAt !== 'number') {
    return noStore(
      NextResponse.json(
        {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Du är inte inloggad.',
            message_en: 'You are not signed in.',
          },
        },
        { status: 401 },
      ),
    )
  }

  const expiresIn = Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
  return noStore(NextResponse.json({ data: { accessToken, expiresAt, expiresIn } }))
}
