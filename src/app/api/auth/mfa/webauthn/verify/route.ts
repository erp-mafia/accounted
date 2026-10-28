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
import { isWebauthnMfaEnabled } from '@/lib/auth/webauthn-mfa'
import { webauthnRelyingParty } from '@/lib/auth/webauthn-rp'
import type { MFAVerifyWebauthnParams } from '@supabase/supabase-js'

const log = createLogger('auth-mfa-webauthn-verify')

/** The credential as PublicKeyCredential.toJSON() renders it: base64url strings. */
const CredentialSchema = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
  })
  .passthrough()

const VerifySchema = z.object({
  factorId: z.string().uuid(),
  challengeId: z.string().uuid(),
  type: z.enum(['create', 'request']),
  credential: CredentialSchema,
})

/**
 * POST /api/auth/mfa/webauthn/verify: finish a security-key ceremony
 * (crm#1448). 'create' completes an enrolment (behind the flag, like the
 * enrol route); 'request' signs in with a verified key (always available to
 * a key holder, see the challenge route). Success raises the session to AAL2
 * and auth-js writes the new tokens into the HttpOnly session cookie, exactly
 * as the TOTP verify route does.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const validation = await validateBody(request, VerifySchema)
  if (!validation.success) return validation.response
  const { factorId, challengeId, type, credential } = validation.data

  if (type === 'create' && !isWebauthnMfaEnabled()) {
    return authError(404, 'not_found', 'Hittades inte.', 'Not found.')
  }

  const factor = (user.factors ?? []).find((f) => f.id === factorId)
  const expectedStatus = type === 'create' ? 'unverified' : 'verified'
  if (!factor || factor.factor_type !== 'webauthn' || factor.status !== expectedStatus) {
    return authError(404, 'mfa_factor_not_found', 'Säkerhetsnyckeln hittades inte.', 'Security key not found.')
  }

  const limited = await authRateLimit([
    { prefix: 'auth:mfa-webauthn-verify:user', identifier: user.id, maxRequests: 10, windowMs: 5 * 60_000 },
  ])
  if (limited) return limited

  // auth-js serialises the browser's credential object itself; this one was
  // serialised in the browser already, so it carries a toJSON that hands the
  // JSON back unchanged (the path auth-js takes for WebAuthn Level 3 browsers).
  const credentialResponse = { ...credential, toJSON: () => credential }
  const { error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId,
    webauthn: {
      ...(await webauthnRelyingParty(request)),
      type,
      credential_response: credentialResponse,
    },
  } as unknown as MFAVerifyWebauthnParams)
  if (error) {
    log.warn('mfa.verify rejected', { status: error.status, code: error.code })
    return gotrueErrorResponse(error)
  }

  return authOk({ verified: true })
}
