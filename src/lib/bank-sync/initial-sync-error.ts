/**
 * The `initial_sync_error` field of the account-selection PATCH
 * (enable-banking /accounts): what the inline initial backfill reports when
 * it did not complete inside the response. Two outcomes are codes the UI
 * interprets; anything else is the raw message of the failure, meant for
 * logs, which no surface may render verbatim.
 *
 * Owned here (core) so the extension route that writes the field and the
 * onboarding step that reads it share one definition.
 */

/** Another sync holds the shared lease: it imports, the backfill stands down. */
export const INITIAL_SYNC_DEFERRED = 'initial_sync_deferred'
/** The backfill outlived the route's 60 s race and finishes in the background. */
export const INITIAL_SYNC_TIMEOUT = 'initial_sync_timeout'

export type InitialSyncOutcome = 'deferred' | 'timeout' | 'failed'

/**
 * Classify the field for display. Null when there is nothing to show (the
 * backfill completed, or the field is absent or blank).
 */
export function classifyInitialSyncError(raw: unknown): InitialSyncOutcome | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  if (raw === INITIAL_SYNC_DEFERRED) return 'deferred'
  if (raw === INITIAL_SYNC_TIMEOUT) return 'timeout'
  return 'failed'
}
