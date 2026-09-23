/**
 * One-time cleanup of storage left behind by Recapt.
 *
 * Removing the Recapt <script> stops it writing anything NEW, but every
 * browser that has already loaded the app keeps whatever Recapt persisted:
 * observed in production as `__recapt_record_engine` in localStorage. Nothing
 * would ever remove it, because the helper that used to sweep on logout
 * (lib/recapt.ts `clearRecaptIdentity`) is deleted along with the SDK.
 *
 * That leftover is inert, but it is third-party storage from a processor we
 * have told users we no longer use (app/(public)/privacy/page.tsx), and this
 * app's whole analytics posture is "nothing on the device". So we clear it.
 *
 * Matching is by SUBSTRING, not prefix, on purpose. The old sweep tested
 * `key.startsWith('recapt')`, which never actually matched the real key:
 * `__recapt_record_engine` starts with underscores. The app's own keys
 * (`Accounted:chat-sidebar-collapsed`, `gnubok.inbox.onboarding.dismissed`)
 * contain neither token, so there is nothing to collide with.
 *
 * Safe to call on every load: once the keys are gone the loop finds nothing
 * and the whole thing costs one localStorage.length read.
 */
const LEGACY_MARKERS = ['recapt', 'glimt']

function purgeFrom(store: Storage): number {
  let removed = 0
  // Iterate backwards: removeItem() re-indexes the store, so a forward loop
  // skips the entry after each removal.
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i)
    if (!key) continue
    const lower = key.toLowerCase()
    if (LEGACY_MARKERS.some((m) => lower.includes(m))) {
      store.removeItem(key)
      removed++
    }
  }
  return removed
}

export function purgeLegacyAnalyticsStorage(): number {
  if (typeof window === 'undefined') return 0
  let removed = 0
  try {
    removed += purgeFrom(window.localStorage)
  } catch {
    // Storage can throw in private mode / when disabled: never break boot.
  }
  try {
    removed += purgeFrom(window.sessionStorage)
  } catch {
    // Same.
  }
  return removed
}
