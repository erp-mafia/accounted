import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import {
  authOk,
  authRateLimit,
  gotrueErrorResponse,
  rejectCrossSiteAuthRequest,
} from '@/lib/auth/auth-route-helpers'
import { requireSessionAllowingAal1 } from '@/lib/auth/require-session'

const log = createLogger('auth-mfa-verify')

const VerifySchema = z.object({
  factorId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/),
})

/**
 * POST /api/auth/mfa/verify: challenge + verify a TOTP factor in one step.
 *
 * Replaces the browser's mfa.challenge + mfa.verify on /mfa/verify and
 * /mfa/enroll. A successful verify raises the session to AAL2 and auth-js
 * writes the new tokens straight into the HttpOnly session cookie. Reachable
 * at AAL1 (that is its purpose); limited per user on top of GoTrue's per-IP
 * limit, which now sees this server.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const validation = await validateBody(request, VerifySchema)
  if (!validation.success) return validation.response
  const { factorId, code } = validation.data

  const limited = await authRateLimit([
    { prefix: 'auth:mfa-verify:user', identifier: user.id, maxRequests: 10, windowMs: 5 * 60_000 },
  ])
  if (limited) return limited

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
  if (challengeError || !challenge) {
    log.warn('mfa.challenge rejected', { status: challengeError?.status, code: challengeError?.code })
    // A distinct code, so the page can tell "could not start" from "wrong
    // code" (only the latter counts towards its lockout).
    return gotrueErrorResponse({ ...(challengeError ?? { status: 400 }), code: 'mfa_challenge_failed' })
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  })
  if (verifyError) {
    log.warn('mfa.verify rejected', { status: verifyError.status, code: verifyError.code })
    return gotrueErrorResponse(verifyError)
  }

  return authOk({ verified: true })
}
