import { authOk } from '@/lib/auth/auth-route-helpers'
import { hasVerifiedFactor, requireSessionAllowingAal1 } from '@/lib/auth/require-session'
import { verifiedSessionAal } from '@/lib/auth/claims'

export const dynamic = 'force-dynamic'

/**
 * The app_metadata flags the auth pages act on, and nothing else:
 * has_password and bankid_linked (lib/auth/has-password.ts) and
 * mfa_exempt_until (lib/auth/mfa.ts). All written only by the service role.
 */
const EXPOSED_APP_METADATA = ['has_password', 'bankid_linked', 'mfa_exempt_until'] as const

/**
 * GET /api/auth/me: the signed-in user as their own auth pages need it.
 *
 * Replaces the browser's own getUser() and getSession() reads (the browser
 * client holds no session any more): id, e-mail, a pending e-mail
 * change, whether the session is anonymous (sandbox), the app_metadata flags
 * above, and the assurance levels: `currentLevel` from the verified token,
 * `nextLevel` from the server's factor list (aal2 when a verified factor
 * exists), the same pair getAuthenticatorAssuranceLevel() gave.
 *
 * Reachable at AAL1 on purpose (/account/set-password, /mfa/enroll and the
 * recovery session on /reset-password run below AAL2), which is why it uses
 * requireSessionAllowingAal1. It returns only what the user's own session
 * could read from GoTrue itself. 401 without a session.
 */
export async function GET() {
  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const appMetadata: Record<string, unknown> = {}
  for (const key of EXPOSED_APP_METADATA) {
    if (user.app_metadata?.[key] !== undefined) appMetadata[key] = user.app_metadata[key]
  }

  return authOk({
    id: user.id,
    email: user.email ?? null,
    new_email: user.new_email ?? null,
    is_anonymous: user.is_anonymous === true,
    app_metadata: appMetadata,
    aal: {
      currentLevel: await verifiedSessionAal(supabase),
      nextLevel: hasVerifiedFactor(user) ? 'aal2' : 'aal1',
    },
  })
}
