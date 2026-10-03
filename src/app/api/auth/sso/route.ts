import { z } from 'zod'
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

const log = createLogger('auth-sso')

const SsoSchema = z.object({
  next: z.string().max(2048).nullish(),
})

/**
 * A public env value that is actually configured: set, and not the Docker
 * `__NEXT_PUBLIC_*__` sentinel docker-entrypoint.sh replaces at start. Takes
 * the value as an argument so the sentinel literal survives the build (see
 * lib/env/public-flags.ts).
 */
function configuredValue(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && !trimmed.startsWith('__') ? trimmed : null
}

/** The configured SAML provider: an explicit provider id wins over a domain. */
function ssoTarget(): { providerId: string } | { domain: string } | null {
  const providerId = configuredValue(process.env.NEXT_PUBLIC_SSO_PROVIDER_ID)
  if (providerId) return { providerId }
  const domain = configuredValue(process.env.NEXT_PUBLIC_SSO_DOMAIN)
  if (domain) return { domain }
  return null
}

/**
 * POST /api/auth/sso: start a SAML sign-in and return the identity
 * provider's URL for the page to navigate to.
 *
 * Replaces the browser's supabase.auth.signInWithSSO. Starting the flow on
 * the server puts its PKCE verifier in an HttpOnly cookie; /auth/callback
 * exchanges the code with it, exactly as before.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const validation = await validateBody(request, SsoSchema)
  if (!validation.success) return validation.response

  const limited = await authRateLimit([
    { prefix: 'auth:sso:net', identifier: clientNetwork(request), maxRequests: 30, windowMs: 10 * 60_000 },
  ])
  if (limited) return limited

  const target = ssoTarget()
  if (!target) {
    return authError(400, 'sso_not_configured', 'SSO är inte konfigurerat.', 'SSO is not configured.')
  }

  let origin: string
  try {
    origin = await resolveRequestAppOrigin(request)
  } catch (err) {
    if (!(err instanceof BrandLookupFailedError)) throw err
    return authError(503, 'brand_lookup_failed', 'Tillfälligt fel. Försök igen om en stund.', 'Temporary error. Please try again shortly.')
  }

  const next = safeReturnTo(validation.data.next ?? null, '/')
  const redirectTo = `${origin}/auth/callback?flow=oauth&next=${encodeURIComponent(next)}`

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithSSO({ ...target, options: { redirectTo } })
  if (error || !data?.url) {
    log.warn('signInWithSSO rejected', { status: error?.status, code: error?.code })
    return gotrueErrorResponse(error ?? { code: 'sso_failed', status: 400 })
  }
  return authOk({ url: data.url })
}
