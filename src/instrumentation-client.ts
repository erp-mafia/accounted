import { warnIfAnalyticsMisconfigured } from '@/lib/analytics/enabled'
import { purgeLegacyAnalyticsStorage } from '@/lib/analytics/purge-legacy-storage'

// Clear anything Recapt left on the device. Runs unconditionally, BEFORE the
// analytics gate: a browser carrying `__recapt_record_engine` must get cleaned
// up even on a build where PostHog itself is switched off.
purgeLegacyAnalyticsStorage()

/**
 * Client-side instrumentation, run by Next.js before hydration.
 *
 * PostHog is NOT started here any more. Until 2026-10-21 this file called
 * posthog.init() on every page, on the premise that `persistence: 'memory'`
 * let analytics run without a consent banner. Founder decision 2026-10-21
 * replaces that premise: browser analytics (PostHog analytics, masked session
 * replay, surveys) needs the signed-in person's consent, given in the
 * acceptance prompt and changeable in account settings, because LEK 9 kap.
 * 28 § covers reading the device through the script, cookie or not. The
 * start now lives in lib/analytics/client.ts (initAnalytics), called by
 * AnalyticsIdentify only when the stored consent is true. Public and auth
 * pages never load PostHog.
 *
 * Only the development warning for a missing token stays here, so a local
 * setup without PostHog still says so in the console.
 */
warnIfAnalyticsMisconfigured()
