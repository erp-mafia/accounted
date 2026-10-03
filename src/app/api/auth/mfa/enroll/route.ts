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

const log = createLogger('auth-mfa-enroll')

const EnrollSchema = z.object({
  friendlyName: z.string().trim().min(1).max(64).optional(),
})

/**
 * POST /api/auth/mfa/enroll: start a TOTP enrolment.
 *
 * Replaces the /mfa/enroll page's browser listFactors + unenroll + enroll.
 * Unverified TOTP factors left by abandoned attempts are removed first
 * (GoTrue refuses a second factor with the same friendly name), then a new
 * one is created; its QR code and secret go back to the page, which is the
 * point of enrolling. GoTrue keeps its own rules (a user who already has a
 * verified factor must be at AAL2 to add another).
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const validation = await validateBody(request, EnrollSchema)
  if (!validation.success) return validation.response

  const limited = await authRateLimit([
    { prefix: 'auth:mfa-enroll:user', identifier: user.id, maxRequests: 10, windowMs: 60 * 60_000 },
  ])
  if (limited) return limited

  for (const factor of user.factors ?? []) {
    if (factor.factor_type === 'totp' && factor.status !== 'verified') {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
      if (error) log.warn('stale unverified factor could not be removed', { code: error.code })
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    ...(validation.data.friendlyName ? { friendlyName: validation.data.friendlyName } : {}),
  })
  if (error || !data) {
    log.warn('mfa.enroll rejected', { status: error?.status, code: error?.code })
    return gotrueErrorResponse(error ?? { code: 'mfa_enroll_failed', status: 400 })
  }

  return authOk({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret })
}
