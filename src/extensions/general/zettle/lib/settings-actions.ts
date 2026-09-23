/**
 * The Zettle settings panel's server calls, each classified into exactly one
 * outcome. Same doctrine as the Shopify/Stripe panels' settings-actions.
 */

import {
  panelRequest,
  type PanelRequestOptions,
  type PanelRequestResult,
} from '@/lib/browser/panel-request'

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

type SyncCounts = {
  fetched: number
  imported: number
  /** Sales imported unbookable (split tender, gift card, tip); see order-sync. */
  needsReview: number
}

export type ZettleSyncOutcome =
  | { reason: 'revoked' }
  | { reason: 'empty' }
  | { reason: 'partial'; values: SyncCounts & { errors: number } }
  | { reason: 'errors'; values: SyncCounts & { errors: number } }
  | { reason: 'feed'; values: SyncCounts }
  | { reason: 'unknown' }

export function syncSummary(payload: ZettleSyncPayload | null): ZettleSyncOutcome {
  const summary = payload?.transactions
  if (!summary) return { reason: 'unknown' }
  if (summary.revoked === true) return { reason: 'revoked' }
  if (typeof summary.fetched !== 'number') return { reason: 'unknown' }

  const fetched = summary.fetched
  const imported = typeof summary.inserted === 'number' ? summary.inserted : 0
  const errors = typeof summary.errors === 'number' ? summary.errors : 0
  const needsReview = typeof summary.needsReview === 'number' ? summary.needsReview : 0

  if (summary.deadlineReached === true) {
    return { reason: 'partial', values: { fetched, imported, needsReview, errors } }
  }
  if (fetched === 0) return { reason: 'empty' }
  if (errors > 0) return { reason: 'errors', values: { fetched, imported, needsReview, errors } }
  return { reason: 'feed', values: { fetched, imported, needsReview } }
}
