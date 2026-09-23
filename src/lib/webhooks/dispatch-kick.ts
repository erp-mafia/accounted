/**
 * Emit-triggered webhook dispatch kick.
 *
 * Without this, the floor on webhook delivery latency is the per-minute cron
 * at /api/webhooks/dispatch/cron: a delivery enqueued one second after a tick
 * waits the remaining 59 before anyone looks at it. External consumers had no
 * way around that except polling /api/events, which the 100 rpm per-key limit
 * makes expensive and which still cannot beat the tick interval (issue #1201).
 *
 * So: once fanOutToWebhooks has inserted delivery rows, schedule one dispatch
 * cycle immediately. The cron is unchanged and remains the retry and sweep
 * path; this only moves the FIRST attempt forward.
 *
 * Three properties matter and are all load-bearing:
 *
 * 1. NEVER awaited by the emitter. eventBus.emit() is awaited at ~99 call
 *    sites, including journal_entry.committed, and dispatchDueDeliveries POSTs
 *    to receivers with a 10 s timeout each. Awaiting it here would put a
 *    stranger's slow HTTP endpoint on the critical path of committing a
 *    verifikat. kickWebhookDispatch() is synchronous and returns immediately.
 *
 * 2. Coalesced per instance. A bulk operation emits once per row, and each
 *    emission would otherwise schedule its own cycle: 100 bulk-booked
 *    transactions would mean 100 claim round trips. While one kick is
 *    outstanding, further kicks are dropped; the rows they enqueued are picked
 *    up by that kick, the next one, or the cron.
 *
 * 3. Never throws. It runs inside an event-bus subscriber, where an
 *    unhandled rejection would surface as a failed emit on a route that has
 *    already done its real work.
 *
 * claim_due_webhook_deliveries claims with FOR UPDATE SKIP LOCKED and flips
 * rows to in_flight in the same statement, so a kick and the cron never claim
 * the same row at the same moment. That is a claim-time guarantee only, and it
 * is worth being precise about what it does NOT buy: the RPC autocommits, so
 * its locks are gone before any POST is issued, and from then on ownership is
 * just status='in_flight'. Delivery therefore stays at-least-once, exactly as
 * the public docs promise ("the same delivery id may arrive more than once ...
 * idempotency is on you").
 *
 * The kick does not widen that. Since #1257 the stuck sweep's window is a
 * constant derived from the dispatcher's cycle budget rather than from the
 * caller's batch size, so it is identical for both callers and always wider
 * than any live cycle: neither the cron nor this 5-row kick can re-arm a row
 * the other still owns. What remains is the genuine crash case, where a
 * hard-killed invocation's rows are recovered while its POSTs may still be in
 * flight; the ownership check in touchInFlight drops the loser's POST before
 * it is issued.
 *
 * One asymmetry is worth stating plainly: the cron route backs the dispatcher's
 * CYCLE_BUDGET_MS with `export const maxDuration = 300`, but this path cannot.
 * after() runs inside whatever arbitrary API route emitted the event, and that
 * route's maxDuration is not ours to set. It does not need to be: a kick claims
 * at most KICK_BATCH_SIZE (5) rows and each attempt is capped at
 * REQUEST_TIMEOUT_MS (10 s), so a kick cycle cannot exceed ~50 s of attempt
 * time and the dispatcher's 110 s budget check never fires here. The bound on
 * the kick is its batch size, not a clock.
 */

import { after } from 'next/server'
import { dispatchDueDeliveries } from './dispatcher'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'

const log = createLogger('webhooks/dispatch-kick')

/**
 * Deliveries claimed per emit-triggered cycle. Deliberately far below the
 * cron's 50: this work runs after a user-facing request on the same function
 * instance, and each delivery can burn up to REQUEST_TIMEOUT_MS. Five covers
 * the realistic fanout (one or two receivers for the event that just fired)
 * without letting a backlog turn one request's tail into a minute of work.
 * Anything beyond it is the cron's job, which is what the cron is for.
 */
export const KICK_BATCH_SIZE = 5

/**
 * True while a kick is scheduled but has not started running. Module scope,
 * so it is per function instance rather than global: two concurrent instances
 * each get one in-flight kick, which is fine (SKIP LOCKED makes the claims
 * disjoint).
 */
let kickPending = false

/** Test seam: swap the dispatch implementation without a live Supabase. */
type DispatchFn = typeof dispatchDueDeliveries

/**
 * Schedule one webhook dispatch cycle to run after the current response.
 * Returns immediately; the caller must not await the delivery work.
 */
export function kickWebhookDispatch(dispatchImpl?: DispatchFn): void {
  if (kickPending) return
  kickPending = true

  const dispatch = dispatchImpl ?? dispatchDueDeliveries

  const run = async (): Promise<void> => {
    // Cleared first, not last: a kick scheduled while this cycle is running
    // targets rows this cycle may already have passed, so it deserves its own
    // slot. Clearing here also means a cycle that dies mid-flight cannot
    // wedge the flag on for the life of the instance.
    kickPending = false
    try {
      await dispatch({
        supabase: createServiceClientNoCookies(),
        batchSize: KICK_BATCH_SIZE,
      })
    } catch (err) {
      // The cron will retry every one of these rows. A failed kick is a
      // latency regression, never a lost delivery, so warn rather than error.
      log.warn('emit-triggered webhook dispatch failed; cron will retry', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    // Keeps the serverless instance alive past the response so the POSTs
    // actually complete. Same pattern as the enable-banking callback.
    after(() => run())
  } catch {
    // Outside a request scope (unit tests, scripts, a plain node server):
    // run it as a floating promise instead. Deferred rather than called
    // inline, so this path coalesces a synchronous burst exactly like the
    // after() path does: calling run() here would clear kickPending before
    // the next kick in the same tick ever sees it. run() never rejects.
    queueMicrotask(() => void run())
  }
}

/** Test-only: reset the coalescing flag between cases. */
export function resetKickStateForTests(): void {
  kickPending = false
}
