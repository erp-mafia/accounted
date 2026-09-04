/**
 * The Shopify settings panel's server calls, each classified into exactly one
 * outcome. Same doctrine as the Stripe and WooCommerce panels'
 * settings-actions (see the doc blocks there): never throw, one toast
 * sentence per click, and the classification lives outside the component
 * because component logic has no tests in this repo.
 */

import {
  panelRequest,
  type PanelRequestOptions,
  type PanelRequestResult,
} from '@/lib/browser/panel-request'

/**
 * Deadline for the quick calls (status, toggle, disconnect). Connect probes
 * the merchant's store (token exchange + orders probe, with retries), so it
 * gets a longer one.
 */
export const SHOPIFY_ACTION_TIMEOUT_MS = 15_000
export const SHOPIFY_CONNECT_TIMEOUT_MS = 120_000

/**
 * Deadline for "Synka nu": the route's own ceiling (maxDuration 300 on the
 * extension dispatcher) plus margin, same reasoning as the Stripe/WooCommerce
 * panels. A first sync backfills 90 days and legitimately takes minutes; the
 * server keeps working and advances the cursor even if we aborted, so
 * aborting early would misreport a sync that landed.
 */
export const SHOPIFY_SYNC_TIMEOUT_MS = 310_000

export type ShopifyRequestResult<T> = PanelRequestResult<T>
export type ShopifyRequestOptions = PanelRequestOptions

export { serverErrorMessage } from '@/lib/browser/panel-request'

/** Call one of the panel's endpoints and report exactly why it failed. */
export function shopifyRequest<T>(options: ShopifyRequestOptions): Promise<ShopifyRequestResult<T>> {
  return panelRequest<T>({ timeoutMs: SHOPIFY_ACTION_TIMEOUT_MS, ...options })
}

/** Success body of POST /api/extensions/ext/shopify/sync. */
export interface ShopifySyncPayload {
  success?: boolean
  /** `ShopifySyncSummary` from lib/order-sync.ts, over the wire. */
  transactions?: {
    fetched?: number
    refundsFetched?: number
    inserted?: number
    updated?: number
    unchanged?: number
    errors?: number
    revoked?: boolean
    deadlineReached?: boolean
  } | null
}

type SyncCounts = {
  fetched: number
  imported: number
}

export type ShopifySyncOutcome =
  /** The store rejected the credentials; the connection was flipped to revoked. */
  | { reason: 'revoked' }
  /** The window genuinely held nothing. A real answer, not a silent success. */
  | { reason: 'empty' }
  /**
   * The time budget ran out with orders still unfetched. Reported before the
   * count-based outcomes so a truncated run never reads as a complete one;
   * the cursor persisted, so pressing sync again continues where it stopped.
   * Carries the error count too: a truncated run can also have failed rows,
   * and dropping that number would repeat the silent-partial mistake.
   */
  | { reason: 'partial'; values: SyncCounts & { errors: number } }
  /** Rows landed, and some rows did not. Both halves get said. */
  | { reason: 'errors'; values: SyncCounts & { errors: number } }
  /** Rows landed. */
  | { reason: 'feed'; values: SyncCounts }
  /** 2xx whose body could not be read: the sync ran, the counts are unknown. */
  | { reason: 'unknown' }

/** Turn the sync route's success body into the single sentence the user gets. */
export function syncSummary(payload: ShopifySyncPayload | null): ShopifySyncOutcome {
  const summary = payload?.transactions
  if (!summary) return { reason: 'unknown' }
  if (summary.revoked === true) return { reason: 'revoked' }
  if (typeof summary.fetched !== 'number') return { reason: 'unknown' }

  const fetched = summary.fetched
  // "imported" in the user-facing sentence = new rows this run (inserts).
  const imported = typeof summary.inserted === 'number' ? summary.inserted : 0
  const errors = typeof summary.errors === 'number' ? summary.errors : 0

  if (summary.deadlineReached === true) {
    return { reason: 'partial', values: { fetched, imported, errors } }
  }
  if (fetched === 0) return { reason: 'empty' }
  if (errors > 0) return { reason: 'errors', values: { fetched, imported, errors } }
  return { reason: 'feed', values: { fetched, imported } }
}
