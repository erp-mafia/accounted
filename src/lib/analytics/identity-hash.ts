import 'server-only'
import crypto from 'crypto'

/**
 * HMAC identity verification for PostHog Support (conversations).
 *
 * Without it, a support ticket is scoped to one browser session: the user
 * loses the thread when they switch device, and recovery is by email link.
 * With it, PostHog trusts that this browser really is `distinctId`, so the
 * thread follows the person.
 *
 * The hash MUST be computed server-side. `POSTHOG_SECRET_API_KEY` is a real
 * secret (it also authenticates external API requests), so it is deliberately
 * NOT `NEXT_PUBLIC_`: it must never reach the client bundle. Only the derived
 * hash crosses to the browser, which is safe because it is per-user and
 * useless without the key.
 *
 * Returns null when the key is unset, which is the normal state for local
 * dev, CI and self-hosted. Callers degrade to unverified (browser-scoped)
 * tickets rather than failing.
 */
export function computeIdentityHash(distinctId: string): string | null {
  const secret = process.env.POSTHOG_SECRET_API_KEY
  if (!secret || !distinctId) return null
  return crypto.createHmac('sha256', secret).update(distinctId).digest('hex')
}
