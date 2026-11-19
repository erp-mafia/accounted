/**
 * The WooCommerce settings panel's server calls, each classified into exactly
 * one outcome. Same doctrine as the Stripe panel's settings-actions (see the
 * doc block there): never throw, one toast sentence per click, and the
 * classification lives outside the component because component logic has no
 * tests in this repo.
 */

import {
  panelRequest,
  type PanelRequestOptions,
  type PanelRequestResult,
} from '@/lib/browser/panel-request'
import { feedSyncOutcome, type FeedSyncOutcome } from '@/lib/feed-sync/sync-outcome'

/**
 * Deadline for the quick calls (status, toggle, disconnect). Connect and
 * manual-connect probe the merchant's WooCommerce host (often a slow shared
 * PHP box, with retries), so they get a longer one.
 */
export const WOO_ACTION_TIMEOUT_MS = 15_000
export const WOO_CONNECT_TIMEOUT_MS = 120_000

/**
 * Deadline for "Synka nu" and "Hämta äldre ordrar": the route's own ceiling
 * (maxDuration 300 on the extension dispatcher) plus margin, same reasoning
 * as the Stripe panel. A backfill from a slow host legitimately takes
 * minutes; the server keeps working and advances the cursor even if we
 * aborted, so aborting early would misreport a sync that landed.
 */
export const WOO_SYNC_TIMEOUT_MS = 310_000

export type WooRequestResult<T> = PanelRequestResult<T>
export type WooRequestOptions = PanelRequestOptions

export { serverErrorMessage } from '@/lib/browser/panel-request'

/** Call one of the panel's endpoints and report exactly why it failed. */
export function wooRequest<T>(options: WooRequestOptions): Promise<WooRequestResult<T>> {
  return panelRequest<T>({ timeoutMs: WOO_ACTION_TIMEOUT_MS, ...options })
}

/** Success body of POST /api/extensions/ext/woocommerce/sync. */
export interface WooSyncPayload {
  success?: boolean
  /** `WooCommerceSyncSummary` from lib/order-sync.ts, over the wire. */
  transactions?: {
    fetched?: number
    refundsFetched?: number
    inserted?: number
    updated?: number
    unchanged?: number
    errors?: number
    unknownCurrency?: number
    revoked?: boolean
    deadlineReached?: boolean
  } | null
}

/** The shared ladder (lib/feed-sync/sync-outcome), with this connector's counts. */
export type WooSyncSummary = FeedSyncOutcome

/** Turn the sync route's success body into the single sentence the user gets. */
export function syncSummary(payload: WooSyncPayload | null): WooSyncSummary {
  return feedSyncOutcome(payload, { importedField: 'inserted', extraCounts: ['unknownCurrency'] })
}
