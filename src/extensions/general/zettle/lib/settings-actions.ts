/**
 * The Zettle settings panel's server calls, each classified into exactly one
 * outcome. Same doctrine as the Shopify/Stripe panels' settings-actions.
 */

import {
  panelRequest,
  type PanelRequestOptions,
  type PanelRequestResult,
} from '@/lib/browser/panel-request'
import { feedSyncOutcome, type FeedSyncOutcome } from '@/lib/feed-sync/sync-outcome'

export const ZETTLE_ACTION_TIMEOUT_MS = 15_000
export const ZETTLE_CONNECT_TIMEOUT_MS = 30_000
export const ZETTLE_SYNC_TIMEOUT_MS = 310_000

export type ZettleRequestResult<T> = PanelRequestResult<T>
export type ZettleRequestOptions = PanelRequestOptions

export { serverErrorMessage } from '@/lib/browser/panel-request'

export function zettleRequest<T>(options: ZettleRequestOptions): Promise<ZettleRequestResult<T>> {
  return panelRequest<T>({ timeoutMs: ZETTLE_ACTION_TIMEOUT_MS, ...options })
}

export interface ZettleSyncPayload {
  success?: boolean
  transactions?: {
    fetched?: number
    refundsFetched?: number
    inserted?: number
    updated?: number
    unchanged?: number
    errors?: number
    revoked?: boolean
    deadlineReached?: boolean
    needsReview?: number
  } | null
}

/** The shared ladder (lib/feed-sync/sync-outcome), with this connector's counts. */
export type ZettleSyncOutcome = FeedSyncOutcome

/** Turn the sync route's success body into the single sentence the user gets. */
export function syncSummary(payload: ZettleSyncPayload | null): ZettleSyncOutcome {
  return feedSyncOutcome(payload, { importedField: 'inserted', extraCounts: ['needsReview'] })
}
