import { analyticsReady, initAnalytics } from './client'
import {
  buildGroupProperties,
  buildPersonProperties,
  type AnalyticsCompanyInput,
  type AnalyticsUserInput,
} from './properties'

export interface SignedInAnalyticsInput {
  /**
   * False only when the person switched analytics off. The layouts pass
   * `user_preferences.analytics_consent !== false`, so a person never asked
   * (null) is on: founder decision 2026-10-22, opt-out in Inställningar, Konto.
   */
  analyticsOn: boolean
  user: AnalyticsUserInput
  /** Server-computed HMAC of userId (lib/analytics/identity-hash.ts); null off hosted. */
  identityHash?: string | null
  /** The active company. Absent before the person has one (the onboarding layout). */
  company?: AnalyticsCompanyInput
}

/**
 * Start PostHog in this tab and attach the signed-in person to it, and their
 * active company when there is one. AnalyticsIdentify's effect calls this on
 * every signed-in load; it lives here so the order is unit-tested (the repo's
 * Vitest cannot render components).
 *
 * Since 2026-10-22 PostHog starts here and nowhere else, so the order is the
 * contract:
 *
 * 1. Analytics switched off: return before anything, PostHog never starts.
 * 2. initAnalytics(): idempotent, one posthog.init per tab however often this
 *    runs (re-renders, client-side navigation between layouts).
 * 3. setIdentity before identify: it tells PostHog Support this browser really
 *    is the user, so a ticket follows the person across devices. Skipped
 *    without the secret key; tickets then fall back to email recovery.
 * 4. identify on every call: with `persistence: 'memory'` a hard reload starts
 *    a fresh anonymous id, so each load identifies again.
 * 5. group only with a company.
 *
 * Returns whether the person was identified.
 */
export function identifySignedInPerson(input: SignedInAnalyticsInput): boolean {
  if (!input.analyticsOn) return false
  if (!initAnalytics()) return false

  const { user, identityHash, company } = input
  // Queued behind posthog.init: the SDK loads after the page (client.ts).
  void analyticsReady().then((posthog) => {
    if (!posthog) return
    try {
      if (identityHash) posthog.setIdentity(user.userId, identityHash)
      posthog.identify(user.userId, buildPersonProperties(user))

      if (company?.id && company.name) {
        posthog.group('company', company.id, buildGroupProperties(company))
      }
    } catch {
      // Telemetry must never break the page that identified the person.
    }
  })
  return true
}
