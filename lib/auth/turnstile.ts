/**
 * Client-side Cloudflare Turnstile rollout state for Supabase Auth.
 *
 * The public site key is intentionally safe to ship to the browser. The
 * matching secret stays in Supabase Auth and must never be added to this app.
 * A generic Docker image contains the sentinel below until its entrypoint
 * substitutes the operator's runtime value, so an unsubstituted sentinel must
 * fail open as "disabled" rather than render a broken widget.
 */

export const TURNSTILE_SITE_KEY_ENV = 'NEXT_PUBLIC_TURNSTILE_SITE_KEY'

const UNCONFIGURED_SITE_KEYS = new Set([
  '',
  '__NEXT_PUBLIC_TURNSTILE_SITE_KEY__',
])

export type TurnstileRolloutState = 'disabled' | 'client-enabled'

export function resolveTurnstileSiteKey(
  value: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
): string | null {
  const siteKey = value?.trim() ?? ''
  return UNCONFIGURED_SITE_KEYS.has(siteKey) ? null : siteKey
}

export function getTurnstileRolloutState(
  value: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
): TurnstileRolloutState {
  return resolveTurnstileSiteKey(value) ? 'client-enabled' : 'disabled'
}

export function captchaTokenOptions(
  token: string | null | undefined,
): { captchaToken?: string } {
  const captchaToken = token?.trim()
  return captchaToken ? { captchaToken } : {}
}

/**
 * Missing CAPTCHA configuration is an intentional rollout state: existing
 * Auth flows keep working until the public site key is deployed. Once a site
 * key exists, every protected form fails closed until Turnstile supplies a
 * token.
 */
export function isTurnstileSubmissionBlocked(
  token: string | null | undefined,
  siteKeyValue: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
): boolean {
  return resolveTurnstileSiteKey(siteKeyValue) !== null && !captchaTokenOptions(token).captchaToken
}
