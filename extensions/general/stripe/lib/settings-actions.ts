/**
 * The Stripe settings panel's server calls, each classified into exactly one
 * outcome.
 *
 * Why this exists: the panel's click handlers were `try { ... } finally {
 * setSyncing(false) }` with no `catch`. A fetch that rejected (offline, DNS,
 * connection reset, a serverless instance that never answers) skipped every
 * toast line and landed in `finally`, so the spinner started, stopped, and the
 * user was told nothing at all: not that it failed, not to retry, not to check
 * the connection.
 *
 * The classification lives here rather than inside the component because this
 * repo has no component tests (vitest runs in `node`, scoped to `lib/` and
 * `app/api/`): logic left in the panel is logic nothing can check.
 *
 * The failure union is `@/lib/browser/action-failure`'s, so the panel maps a
 * failure through the same `failureDescription` as the salary payment panels and
 * the three reasons mean the same thing everywhere in the app.
 *
 * Exactly one toast per click: TOAST_LIMIT is 1 (components/ui/use-toast.tsx),
 * so a second toast emitted in the same tick evicts the first and only the last
 * one is ever rendered. Every outcome below therefore resolves to one sentence.
 */

import {
  panelRequest,
  type PanelRequestOptions,
  type PanelRequestResult,
} from '@/lib/browser/panel-request'

/**
 * Deadline for the panel's quick calls: the status read, the connect handshake,
 * disconnect, and the transaction-sync toggle. Each is a single indexed row plus
 * at most one outward Stripe call, so the realistic worst case is a cold start
 * and one eu-north-1 round trip. Same value as POST_ACTION_TIMEOUT_MS: a shorter
 * deadline would report a failure for a write that may well have landed.
 */
export const STRIPE_ACTION_TIMEOUT_MS = 15_000

/**
 * Deadline for "Synka nu".
 *
 * Deliberately far longer than the writes. A first sync backfills 90 days and up
 * to 10 000 balance transactions (BACKFILL_DAYS / MAX_TXNS_PER_RUN in
 * transaction-sync.ts), which legitimately takes minutes, and aborting early
 * would be worse than the missing catch this replaces: the server keeps working
 * and advances `last_balance_txn_synced_at`, so the user would be told the sync
 * failed and then find nothing on the retry. The only honest bound is the
 * route's own ceiling (`export const maxDuration = 300` in
 * app/api/extensions/ext/[...path]/route.ts) plus a margin for the platform's
 * own error response: past that, no answer is ever coming.
 */
export const STRIPE_SYNC_TIMEOUT_MS = 310_000

export type StripeRequestResult<T> = PanelRequestResult<T>
export type StripeRequestOptions = PanelRequestOptions

export { serverErrorMessage } from '@/lib/browser/panel-request'

/** Call one of the panel's endpoints and report exactly why it failed. */
export function stripeRequest<T>(options: StripeRequestOptions): Promise<StripeRequestResult<T>> {
  return panelRequest<T>({ timeoutMs: STRIPE_ACTION_TIMEOUT_MS, ...options })
}

/** Success body of POST /api/extensions/ext/stripe/sync. */
export interface StripeSyncPayload {
  success?: boolean
  /** `StripeTransactionSyncSummary` from lib/transaction-sync.ts, over the wire. */
  transactions?: {
    fetched?: number
    imported?: number
    duplicates?: number
    linked?: number
    errors?: number
    revoked?: boolean
    /**
     * Only set when the caller passes a time budget. The manual button's route
     * passes none, so it cannot appear here; the nightly cron owns that case.
     */
    deadlineReached?: boolean
  }
}

/**
 * A type alias, not an interface: next-intl's `t(key, values)` takes a
 * `Record<string, string | number | Date>`, and only anonymous object types get
 * the implicit index signature that makes them assignable to it.
 */
type SyncCounts = {
  fetched: number
  imported: number
  linked: number
}

export type StripeSyncSummary =
  /**
   * Stripe revoked the connection upstream. A 200, but not a completed sync:
   * `syncStripeBalanceTransactions` returns `{ revoked: true }` with every count
   * at zero, which the panel used to report as a finished sync that "returned no
   * transactions for the period", sending the user to check the wrong thing.
   */
  | { reason: 'revoked' }
  /** The window genuinely held nothing. A real answer, not a silent success. */
  | { reason: 'empty' }
  /** Rows landed, and some rows did not. Both halves get said. */
  | { reason: 'errors'; values: SyncCounts & { errors: number } }
  /** Rows landed. */
  | { reason: 'feed'; values: SyncCounts }
  /**
   * 2xx whose body could not be read. The sync ran (the server had already
   * committed by the time it flushed headers), but the counts are unknown, so
   * the panel says the sync finished and stops there rather than reporting the
   * missing numbers as zero and calling the run empty.
   */
  | { reason: 'unknown' }

/**
 * Turn the sync route's success body into the single sentence the user gets.
 */
export function syncSummary(payload: StripeSyncPayload | null): StripeSyncSummary {
  const summary = payload?.transactions
  if (!summary) return { reason: 'unknown' }
  if (summary.revoked === true) return { reason: 'revoked' }
  if (typeof summary.fetched !== 'number') return { reason: 'unknown' }

  const fetched = summary.fetched
  const imported = typeof summary.imported === 'number' ? summary.imported : 0
  const linked = typeof summary.linked === 'number' ? summary.linked : 0
  const errors = typeof summary.errors === 'number' ? summary.errors : 0

  if (fetched === 0) return { reason: 'empty' }
  if (errors > 0) return { reason: 'errors', values: { fetched, imported, linked, errors } }
  return { reason: 'feed', values: { fetched, imported, linked } }
}
