import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import {
  authError,
  authOk,
  authRateLimit,
  gotrueErrorResponse,
  rejectCrossSiteAuthRequest,
} from '@/lib/auth/auth-route-helpers'
import { requireSessionAllowingAal1 } from '@/lib/auth/require-session'
import { toWebauthnJson } from '@/lib/auth/webauthn-mfa'
import { webauthnRelyingParty } from '@/lib/auth/webauthn-rp'

const log = createLogger('auth-mfa-webauthn-challenge')

const ChallengeSchema = z.object({
  factorId: z.string().uuid(),
})

/**
 * POST /api/auth/mfa/webauthn/challenge: the request options for signing in
 * with a verified security key (crm#1448). The browser runs
 * navigator.credentials.get and finishes at /api/auth/mfa/webauthn/verify.
 *
 * Not behind the flag on purpose: only a user who already holds a verified
 * security-key factor gets past the factor check, so the route is inert for
 * everyone else, and switching the flag off must never strand a key holder
 * at /mfa/verify. Reachable at AAL1 (that is its purpose).
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const validation = await validateBody(request, ChallengeSchema)
  if (!validation.success) return validation.response
  const { factorId } = validation.data

  const factor = (user.factors ?? []).find((f) => f.id === factorId)
  if (!factor || factor.factor_type !== 'webauthn' || factor.status !== 'verified') {
    return authError(404, 'mfa_factor_not_found', 'Säkerhetsnyckeln hittades inte.', 'Security key not found.')
  }

  const limited = await authRateLimit([
    { prefix: 'auth:mfa-webauthn-challenge:user', identifier: user.id, maxRequests: 20, windowMs: 5 * 60_000 },
  ])
  if (limited) return limited

  const { data: challenge, error } = await supabase.auth.mfa.challenge({
    factorId,
    webauthn: await webauthnRelyingParty(request),
  })
  if (error || !challenge || challenge.type !== 'webauthn' || challenge.webauthn.type !== 'request') {
    log.warn('mfa.challenge rejected', { status: error?.status, code: error?.code })
    return gotrueErrorResponse({ ...(error ?? { status: 400 }), code: 'mfa_challenge_failed' })
  }

  return authOk({
    challengeId: challenge.id,
    publicKey: toWebauthnJson(challenge.webauthn.credential_options.publicKey),
  })
}
