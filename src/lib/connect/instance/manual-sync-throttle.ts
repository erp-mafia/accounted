/**
 * Cooldown for the operator-triggered connector sync (POST /api/connector/sync).
 * Every run POSTs the instance's company count to the hosted entitlements
 * endpoint, so a click storm in the settings panel must not turn into a
 * request storm against the hosted service. Module-level state is enough:
 * self-hosted runs as one long-lived process, and the hourly cron is
 * unaffected (it never goes through this gate).
 */
export const MANUAL_SYNC_COOLDOWN_MS = 60_000

let inFlight = false
let lastStartedAt = 0

/** Claims the sync slot; false while a sync runs or the cooldown holds. */
export function tryBeginManualSync(now: number = Date.now()): boolean {
  if (inFlight || now - lastStartedAt < MANUAL_SYNC_COOLDOWN_MS) return false
  inFlight = true
  lastStartedAt = now
  return true
}

export function endManualSync(): void {
  inFlight = false
}

/** Test hook: clears the in-flight flag and the cooldown window. */
export function resetManualSyncThrottle(): void {
  inFlight = false
  lastStartedAt = 0
}
