import { warnIfAnalyticsMisconfigured } from '@/lib/analytics/enabled'
import { bufferEarlyErrors } from '@/lib/analytics/early-errors'
import { purgeLegacyAnalyticsStorage } from '@/lib/analytics/purge-legacy-storage'
import { installStaleDeployListener } from '@/lib/browser/stale-deploy'

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
 * What stays here: the development warning for a missing token, so a local
 * setup without PostHog still says so in the console, and the in-memory hold
 * on errors raised before PostHog starts (lib/analytics/early-errors.ts).
 * Hydration errors happen exactly then, so without the hold PostHog never
 * sees a React #418; nothing is sent unless initAnalytics() runs.
 */
if (warnIfAnalyticsMisconfigured()) bufferEarlyErrors(window)

// A click on a Server Action an older build defined (a tab opened before a
// deploy) throws UnrecognizedActionError; DeployReloadPrompt then offers the
// reload instead of leaving a dead click (lib/browser/stale-deploy.ts).
installStaleDeployListener(window)
