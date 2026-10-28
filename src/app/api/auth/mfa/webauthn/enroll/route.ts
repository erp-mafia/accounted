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
import { isWebauthnMfaEnabled, toWebauthnJson } from '@/lib/auth/webauthn-mfa'
import { webauthnRelyingParty } from '@/lib/auth/webauthn-rp'

const log = createLogger('auth-mfa-webauthn-enroll')

const EnrollSchema = z.object({
  friendlyName: z.string().trim().min(1).max(64).optional(),
})

/**
 * POST /api/auth/mfa/webauthn/enroll: start a security-key enrolment
 * (crm#1448). Behind NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED: off, the route does
 * not exist (404).
 *
 * Mirrors the TOTP enrol route: unverified security-key factors left by
 * abandoned attempts go first, then a new factor is created and challenged
 * at once, and the creation options go back to the browser, which runs
 * navigator.credentials.create and finishes at /api/auth/mfa/webauthn/verify.
 * GoTrue keeps its own rules (a user who already has a verified factor must
 * be at AAL2 to add another).
 */
export async function POST(request: Request) {
  if (!isWebauthnMfaEnabled()) {
    return authError(404, 'not_found', 'Hittades inte.', 'Not found.')
  }

  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const validation = await validateBody(request, EnrollSchema)
  if (!validation.success) return validation.response

  const limited = await authRateLimit([
    { prefix: 'auth:mfa-webauthn-enroll:user', identifier: user.id, maxRequests: 10, windowMs: 60 * 60_000 },
  ])
  if (limited) return limited

  let keyCount = 0
  for (const factor of user.factors ?? []) {
    if (factor.factor_type !== 'webauthn') continue
    if (factor.status === 'verified') {
      keyCount++
      continue
    }
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
    if (error) log.warn('stale unverified factor could not be removed', { code: error.code })
  }

  // GoTrue refuses two factors with the same friendly name, so a second key
  // gets a numbered default.
  const friendlyName = validation.data.friendlyName ?? `Säkerhetsnyckel ${keyCount + 1}`
  const { data: factor, error: enrollError } = await supabase.auth.mfa.enroll({
    factorType: 'webauthn',
    friendlyName,
  })
  if (enrollError || !factor) {
    log.warn('mfa.enroll rejected', { status: enrollError?.status, code: enrollError?.code })
    return gotrueErrorResponse(enrollError ?? { code: 'mfa_enroll_failed', status: 400 })
  }

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: factor.id,
    webauthn: await webauthnRelyingParty(request),
  })
  if (challengeError || !challenge || challenge.type !== 'webauthn' || challenge.webauthn.type !== 'create') {
    log.warn('mfa.challenge rejected', { status: challengeError?.status, code: challengeError?.code })
    return gotrueErrorResponse({ ...(challengeError ?? { status: 400 }), code: 'mfa_challenge_failed' })
  }

  return authOk({
    factorId: factor.id,
    challengeId: challenge.id,
    publicKey: toWebauthnJson(challenge.webauthn.credential_options.publicKey),
  })
}
