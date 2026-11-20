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

const log = createLogger('auth-otp')

const TokenHashSchema = z.object({
  // magiclink: the one-time link the BankID extension mints after a BankID
  // login (extensions/general/tic); recovery: the password-reset mail.
  type: z.enum(['magiclink', 'recovery']),
  token_hash: z.string().trim().min(1).max(512),
})

const EmailCodeSchema = z.object({
  type: z.literal('recovery'),
  email: z.string().trim().toLowerCase().max(320).pipe(z.string().email()),
  // The project's Email OTP Length (6-10 digits); never cap at 6.
  token: z.string().trim().regex(/^\d{6,10}$/),
})

const OtpSchema = z.union([TokenHashSchema, EmailCodeSchema])

/**
 * POST /api/auth/otp: exchange a one-time token for a session.
 *
 * Replaces the browser's supabase.auth.verifyOtp on the login and register
 * pages (the BankID magic link) and on /reset-password (recovery link or
 * e-mailed code): with the session cookie HttpOnly, the session has to be
 * minted where the cookie can be written. Anonymous by design. Limited per
 * network and, for the typed-code variant, per address, since GoTrue's
 * per-IP verify limit now sees this server.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const validation = await validateBody(request, OtpSchema)
  if (!validation.success) return validation.response
  const input = validation.data

  const limited = await authRateLimit([
    { prefix: 'auth:otp:net', identifier: clientNetwork(request), maxRequests: 30, windowMs: 10 * 60_000 },
    ...('email' in input
      ? [{ prefix: 'auth:otp:email', identifier: emailRateKey(input.email), maxRequests: 10, windowMs: 15 * 60_000 }]
      : []),
  ])
  if (limited) return limited

  const supabase = await createClient()
  const { data, error } =
    'token_hash' in input
      ? await supabase.auth.verifyOtp({ token_hash: input.token_hash, type: input.type })
      : await supabase.auth.verifyOtp({ email: input.email, token: input.token, type: 'recovery' })

  if (error || !data.session) {
    log.warn('verifyOtp rejected', { type: input.type, status: error?.status, code: error?.code })
    return gotrueErrorResponse(error ?? { code: 'otp_invalid', status: 400 })
  }

  const response = authOk({ mfaRequired: stepUpOwed(data.user, data.session.access_token) })
  // The only magic link this app hands to a browser is the BankID login's.
  if (input.type === 'magiclink') setSessionAuthMethodHint(response, request, 'bankid')
  return response
}
