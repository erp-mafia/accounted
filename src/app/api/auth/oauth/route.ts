import { z } from 'zod'
import type { Provider } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import {
  BrandLookupFailedError,
  resolveRequestAppOrigin,
} from '@/lib/domains/trusted-app-origin'
import { createLogger } from '@/lib/logger'
import {
  authError,
  authOk,
  authRateLimit,
  clientNetwork,
  gotrueErrorResponse,
  rejectCrossSiteAuthRequest,
} from '@/lib/auth/auth-route-helpers'

const log = createLogger('auth-oauth')

const OAuthSchema = z.object({
  // A GoTrue provider id (google, azure, github, or a custom OIDC id).
  // GoTrue rejects providers that are not enabled.
  provider: z.string().trim().regex(/^[a-z0-9][a-z0-9_:-]{0,63}$/i),
  next: z.string().max(2048).nullish(),
})

/**
 * POST /api/auth/oauth: start an OAuth sign-in (Google and the other GoTrue
 * providers) and return the provider URL for the page to navigate to.
 *
 * Replaces the browser's supabase.auth.signInWithOAuth. Started here, the
 * flow's PKCE verifier is an HttpOnly cookie; /auth/callback exchanges the
 * code with it as before. The callback is built on the trusted origin of the
 * requesting host (the same registry signup and password reset use), not on
 * whatever Host header arrives.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const validation = await validateBody(request, OAuthSchema)
  if (!validation.success) return validation.response

  const limited = await authRateLimit([
    { prefix: 'auth:oauth:net', identifier: clientNetwork(request), maxRequests: 30, windowMs: 10 * 60_000 },
  ])
  if (limited) return limited

  let origin: string
  try {
    origin = await resolveRequestAppOrigin(request)
  } catch (err) {
    if (!(err instanceof BrandLookupFailedError)) throw err
    return authError(503, 'brand_lookup_failed', 'Tillfälligt fel. Försök igen om en stund.', 'Temporary error. Please try again shortly.')
  }

  const callback = new URL('/auth/callback', origin)
  callback.searchParams.set('flow', 'oauth')
  const next = safeReturnTo(validation.data.next ?? null, '/')
  if (next !== '/') callback.searchParams.set('next', next)

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: validation.data.provider as Provider,
    options: { redirectTo: callback.toString(), skipBrowserRedirect: true },
  })
  if (error || !data?.url) {
    log.warn('signInWithOAuth rejected', { status: error?.status, code: error?.code })
    return gotrueErrorResponse(error ?? { code: 'oauth_failed', status: 400 })
  }
  return authOk({ url: data.url })
}
