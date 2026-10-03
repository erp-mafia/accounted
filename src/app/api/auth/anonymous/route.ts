import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import {
  authOk,
  authRateLimit,
  clientNetwork,
  gotrueErrorResponse,
  rejectCrossSiteAuthRequest,
} from '@/lib/auth/auth-route-helpers'

const log = createLogger('auth-anonymous')

const AnonymousSchema = z.object({
  captchaToken: z.string().max(4096).nullish(),
})

/**
 * POST /api/auth/anonymous: the sandbox's anonymous sign-in.
 *
 * Replaces the sandbox page's browser supabase.auth.signInAnonymously, so
 * the anonymous session lives in the same HttpOnly cookie as every other
 * session. The Turnstile token is forwarded as before; the per-network
 * limit stands in for GoTrue's per-IP one, which now sees this server.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const validation = await validateBody(request, AnonymousSchema)
  if (!validation.success) return validation.response
  const { captchaToken } = validation.data

  const limited = await authRateLimit([
    { prefix: 'auth:anonymous:net', identifier: clientNetwork(request), maxRequests: 10, windowMs: 60 * 60_000 },
  ])
  if (limited) return limited

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInAnonymously(
    captchaToken ? { options: { captchaToken } } : undefined,
  )
  if (error || !data.session) {
    log.warn('signInAnonymously rejected', { status: error?.status, code: error?.code })
    return gotrueErrorResponse(error ?? { code: 'anonymous_failed', status: 400 })
  }
  return authOk({ ok: true })
}
