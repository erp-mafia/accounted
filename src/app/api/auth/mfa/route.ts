import { authOk } from '@/lib/auth/auth-route-helpers'
import { hasVerifiedFactor, requireSessionAllowingAal1 } from '@/lib/auth/require-session'
import { verifiedSessionAal } from '@/lib/auth/claims'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/mfa: the user's MFA factors and the session's assurance
 * levels. Replaces browser supabase.auth.mfa.listFactors() and
 * getAuthenticatorAssuranceLevel(). The factor list is the server's
 * (getUser), the current level the verified token's; neither comes from a
 * cookie. Reachable at AAL1: /mfa/verify needs it to find the factor to
 * verify.
 */
export async function GET() {
  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const factors = (user.factors ?? []).map((factor) => ({
    id: factor.id,
    factor_type: factor.factor_type,
    status: factor.status,
    friendly_name: factor.friendly_name ?? null,
  }))

  return authOk({
    factors,
    currentLevel: await verifiedSessionAal(supabase),
    nextLevel: hasVerifiedFactor(user) ? 'aal2' : 'aal1',
  })
}
