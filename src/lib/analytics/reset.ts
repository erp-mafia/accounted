import posthog from 'posthog-js'
import { isAnalyticsEnabled } from './enabled'

/**
 * Detach the current person from PostHog on logout.
 *
 * Call this ONLY on the transition out of an identified session, never on an
 * initially anonymous page load: reset() discards the anonymous distinct id
 * and the history attached to it, so a stray call at boot would sever the
 * pre-login part of a signup funnel.
 *
 * Replaces clearRecaptIdentity() from lib/recapt.ts. That helper also had to
 * sweep localStorage by key prefix, because Recapt cached the uid there. We
 * run with `persistence: 'memory'`, so there is no cached identity to wipe:
 * reset() is sufficient.
 *
 * This call is load-bearing for shared devices, not just tidiness.
 * `posthog.reset()` also resets the conversations manager, which removes the
 * `ph_conv_<token>` key holding the support-ticket session id. Without it the
 * next person at the same browser would inherit the previous user's ticket
 * session. Do not "optimise" this away when analytics is otherwise quiet.
 *
 * What it does NOT clear: `seenSurvey_<id>`. No PostHog bundle enumerates
 * localStorage, so the SDK cannot find those keys to delete them. That is
 * accepted, and desirable: clearing them would re-prompt every survey to the
 * next person on the device. See the client-side storage inventory in
 * .compliance/Data_Classification_Handling.md.
 */
export function resetAnalyticsIdentity(): void {
  if (typeof window === 'undefined') return
  if (!isAnalyticsEnabled()) return
  try {
    posthog.reset()
  } catch {
    // best-effort: we're already in a logout flow
  }
}
