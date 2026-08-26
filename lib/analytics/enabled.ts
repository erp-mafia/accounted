/**
 * PostHog analytics gate.
 *
 * Analytics is a HOSTED-ONLY feature. Self-hosted deployments never load
 * PostHog: an AGPL operator running their own instance should not have their
 * users' behaviour shipped to our project, and the token is not baked into
 * the Docker image (no `__NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN__` sentinel in
 * Dockerfile / docker-entrypoint.sh, deliberately). Recapt achieved the same
 * result only by accident, via that missing sentinel; here it is explicit.
 *
 * Mirrors the shape of `isBankIdEnabled()` in lib/auth/bankid.ts: self-hosted
 * short-circuits first, then the feature's own env var decides.
 */

import { isSelfHosted } from '@/lib/env/public-flags'

export const POSTHOG_TOKEN_VAR = 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN'

export function isAnalyticsEnabled(): boolean {
  if (isSelfHosted()) return false
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN)
}

/**
 * A missing token must never break the app, but it must not fail silently
 * either: without it every capture is dropped and the integration looks
 * healthy while zero events arrive (PostHog's own framework rule). So we warn
 * loudly in development and stay a no-op in production.
 *
 * Returns true when the caller should proceed with initialisation.
 */
export function warnIfAnalyticsMisconfigured(): boolean {
  if (isAnalyticsEnabled()) return true

  // Self-hosted is a deliberate off, not a misconfiguration: stay quiet.
  if (isSelfHosted()) return false

  if (process.env.NODE_ENV === 'development') {
    // console, not createLogger(): this runs in the browser from
    // instrumentation-client.ts before anything else is wired, and the point
    // is for a developer to see it in the devtools console immediately.
    // eslint-disable-next-line no-console
    console.warn(
      `${POSTHOG_TOKEN_VAR} variable required by PostHog is missing or un-configured, ` +
        `this causes events to be silently missed. This error stops appearing once ` +
        `${POSTHOG_TOKEN_VAR} is configured`
    )
  }
  return false
}
