import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import {
  authOk,
  authRateLimit,
  clientNetwork,
  emailRateKey,
  gotrueErrorResponse,
  rejectCrossSiteAuthRequest,
  setSessionAuthMethodHint,
  stepUpOwed,
} from '@/lib/auth/auth-route-helpers'

const log = createLogger('auth-login')

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.string().email()),
  // No strength policy here: existing passwords predate the current one.
  password: z.string().min(1).max(256),
  captchaToken: z.string().max(4096).nullish(),
})

/**
 * POST /api/auth/login: e-mail + password sign-in.
 *
 * Replaces the login page's browser supabase.auth.signInWithPassword: the
 * session cookie is HttpOnly now (CASA 2.3.1/2.3.2), so the sign-in has to
 * run where it can be written. Same GoTrue call, the same Turnstile token
 * forwarded; on top, a per-network and a per-address limit (GoTrue's own
 * per-IP limit now sees this server's address instead of the user's).
 *
 * Anonymous by design (nobody is signed in yet), so no requireAuth. Answers
 * `mfaRequired` when the account has a verified factor and the new session is
 * still AAL1: the page then continues to /mfa/verify, as it did when it asked
 * getAuthenticatorAssuranceLevel() itself.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const validation = await validateBody(request, LoginSchema)
  if (!validation.success) return validation.response
  const { email, password, captchaToken } = validation.data

  const limited = await authRateLimit([
    { prefix: 'auth:login:net', identifier: clientNetwork(request), maxRequests: 60, windowMs: 10 * 60_000 },
    { prefix: 'auth:login:email', identifier: emailRateKey(email), maxRequests: 10, windowMs: 15 * 60_000 },
  ])
  if (limited) return limited

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
    ...(captchaToken ? { options: { captchaToken } } : {}),
  })

  if (error || !data.session) {
    log.warn('signInWithPassword rejected', { status: error?.status, code: error?.code })
    return gotrueErrorResponse(error ?? { code: 'auth_error', status: 400 })
  }

  const response = authOk({ mfaRequired: stepUpOwed(data.user, data.session.access_token) })
  setSessionAuthMethodHint(response, request, 'password')
  return response
}
