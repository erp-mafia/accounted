import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import {
  BrandLookupFailedError,
  buildPasswordResetRedirectTo,
  requestHost,
} from '@/lib/domains/trusted-app-origin'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createLogger } from '@/lib/logger'

const log = createLogger('auth-password-reset')

/**
 * POST /api/auth/password-reset: request a password recovery mail.
 *
 * Moved server-side so the recovery callback is resolved against the brands
 * table (lib/domains/trusted-app-origin.ts) instead of a domain list compiled
 * into the browser bundle. The login page used to call
 * supabase.auth.resetPasswordForEmail directly with a redirectTo it validated
 * against NEXT_PUBLIC_WHITELABEL_DOMAINS; every new brand then needed that
 * env var updated and a redeploy, and when that was forgotten the mail went
 * out canonical-branded to the canonical host. Here the request host decides:
 * a registered brand host gets its own callback (and, through the Send Email
 * hook, its own brand), everything else gets the canonical one.
 *
 * Anonymous by design: a user asking for a reset has no session, so no
 * withRouteContext / requireAuth. Abuse is bounded exactly as the direct
 * GoTrue call was: the forwarded Turnstile token (verified by GoTrue) plus
 * GoTrue's own recovery rate limits. A signed-in user may also call this
 * (the login page is reachable while signed in); the cookie-backed client
 * carries their session and GoTrue behaves the same either way.
 *
 * The response never says whether the address exists: GoTrue answers 200 for
 * unknown addresses and this route passes that through unchanged.
 */

const PasswordResetSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.string().email()),
  captchaToken: z.string().max(4096).nullish(),
})

export async function POST(request: Request) {
  const validation = await validateBody(request, PasswordResetSchema)
  if (!validation.success) return validation.response
  const { email, captchaToken } = validation.data

  let redirectTo: string
  try {
    redirectTo = await buildPasswordResetRedirectTo(requestHost(request))
  } catch (err) {
    if (!(err instanceof BrandLookupFailedError)) throw err
    // Transient brands-table error: fail safe like /api/auth/signup. A
    // canonical fallback here would mail a white-label user a wrong-brand
    // link; 503 tells the client to retry instead.
    return NextResponse.json(
      {
        error: {
          code: 'brand_lookup_failed',
          message: 'Tillfälligt fel. Försök igen om en stund.',
          message_en: 'Temporary error. Please try again shortly.',
        },
      },
      { status: 503 },
    )
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
    ...(captchaToken ? { captchaToken } : {}),
  })

  if (error) {
    log.warn('resetPasswordForEmail rejected', { status: error.status, code: error.code })
    // Same envelope as /api/auth/signup: the login page feeds it to
    // classifyAuthError (keyed on code and HTTP status) and localizes the
    // display message through getErrorMessage.
    return NextResponse.json(
      {
        error: {
          code: error.code ?? 'auth_error',
          message: getErrorMessage(error, { context: 'auth', locale: 'sv' }),
          message_en: getErrorMessage(error, { context: 'auth', locale: 'en' }),
        },
      },
      { status: error.status && error.status >= 400 ? error.status : 400 },
    )
  }

  return NextResponse.json({ data: { status: 'sent' } })
}
