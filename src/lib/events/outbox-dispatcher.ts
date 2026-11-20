/**
 * The event outbox dispatcher (step E2 shadow mode, step E3 async consumers).
 *
 * Claims due deliveries from event_deliveries (claim_event_deliveries: FOR
 * UPDATE SKIP LOCKED, a lease, the attempt count as fencing token) and
 * finishes them:
 *
 * - A delivery the bus deferred (inline_result 'deferred': the consumer's
 *   switch said outbox on the instance that emitted the event) of a consumer
 *   in ASYNC_EVENT_CONSUMERS (lib/composition/async-event-consumers.ts,
 *   webhooks only) is run here: the consumer's handle() with the service-role
 *   client and the outbox id (ctx.outbox), bounded by HANDLER_TIMEOUT_MS. On
 *   success it is marked done (complete_event_deliveries); on a failure it
 *   goes back to pending after a backoff that doubles per attempt, and dead
 *   after DISPATCH_MAX_ATTEMPTS (fail_event_delivery). The decision is the
 *   delivery's, never this instance's switch: a deferred delivery is run
 *   whatever EVENT_DELIVERY_* says here, so a switch flipped back keeps
 *   draining what was enqueued, and a delivery that ran inline is never run
 *   again.
 * - A deferred delivery of a consumer this code cannot run (a deploy of
 *   other code enqueued it) is failed, retried and finally dead, never
 *   marked done unrun: the reconciliation shows it.
 * - Every other delivery (shadow: the consumer already ran inline in the
 *   emitting request) is marked done without running anything, as in E2.
 *
 * What the cycle measures (how many, how old the oldest was when claimed) is
 * the latency an async consumer sees. With EVENT_OUTBOX_MODE off it does
 * nothing at all.
 *
 * The dispatcher imports the async consumers' handler modules and nothing
 * else of the consumers: its callers (the cron route, the kick in lib/init's
 * graph) compile the webhook fan-out, never every handler.
 *
 * A delivery whose lease runs out on its last attempt (the run was killed, 8
 * times) goes dead inside the claim's SQL, which answers claimed rows only,
 * so nothing ever logged it. The cycle reads the deliveries on their last
 * attempt before it claims and reports, as an error, the ones the claim took
 * dead (reportDeadOnLeaseExpiry). Reading them was chosen over having the
 * claim return them: that needs the function dropped and recreated with a new
 * return type, which code deployed before or after the migration must both
 * survive, for the same log line.
 *
 * Two callers: the per-minute cron (/api/events/dispatch/cron) and the kick
 * after an emit that enqueued something (lib/events/outbox.ts). SKIP LOCKED
 * keeps their claims disjoint.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ASYNC_EVENT_CONSUMERS } from '@/lib/composition/async-event-consumers'
import { createLogger } from '@/lib/logger'
import { eventOutboxMode, type EventOutboxMode } from './consumer-index'
import type { EventConsumer, EventConsumerContext } from './consumers'
import type { CoreEvent } from './types'

const log = createLogger('event-outbox-dispatcher')

/** Deliveries claimed per round trip by the cron. */
export const DISPATCH_BATCH_SIZE = 200

/** How long a claim owns its deliveries before another dispatcher may take them. */
export const DISPATCH_LEASE_SECONDS = 60

/** Claims a delivery gets before an expired lease makes it dead. */
export const DISPATCH_MAX_ATTEMPTS = 8

/** Wall-clock budget of one cycle: well inside the cron route's maxDuration. */
export const DISPATCH_BUDGET_MS = 25_000

/**
 * Longest one async consumer run may take before it counts as failed (and is
 * retried). Below the lease, so a run that times out is failed by the claim
 * that owns it.
 */
export const HANDLER_TIMEOUT_MS = 20_000

/** Async consumer runs at once within a batch. */
export const ASYNC_CONCURRENCY = 8

/** Backoff after the first failed attempt; doubles per attempt up to RETRY_MAX_SECONDS. */
export const RETRY_BASE_SECONDS = 30
export const RETRY_MAX_SECONDS = 3600

/** Seconds before a delivery whose attempt-th run failed is due again: 30, 60, 120, ... up to an hour. */
export function retryAfterSeconds(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16))
  return Math.min(RETRY_BASE_SECONDS * 2 ** exponent, RETRY_MAX_SECONDS)
}

/** The consumers this dispatcher runs, by id. */
const ASYNC_BY_ID: ReadonlyMap<string, EventConsumer> = new Map(
  ASYNC_EVENT_CONSUMERS.map((consumer) => [consumer.id, consumer]),
)

/** One row of claim_event_deliveries. */
export interface ClaimedDelivery {
  outbox_id: number
  consumer_id: string
  attempts: number
  lease_until: string
  company_id: string | null
  event_type: string
  payload: unknown
  created_at: string
  /** What the bus recorded at the emit; 'deferred' means the dispatcher runs the consumer. */
  inline_result?: string | null
}

export interface OutboxDispatchSummary {
  mode: EventOutboxMode
  /** Claim round trips made. */
  batches: number
  claimed: number
  completed: number
  /** Deferred deliveries whose consumer ran here (succeeded or not). */
  ran: number
  /** Deferred deliveries failed back to pending, to be retried after their backoff. */
  retried: number
  /** Deferred deliveries failed for the last time (dead). */
  dead: number
  /** Deliveries the claim took dead because their lease ran out on the last attempt. */
  deadOnLeaseExpiry: number
  /** Age of the oldest delivery claimed (its event's age at the claim), or null with none claimed. */
  oldestAgeMs: number | null
  /** The outbox functions are not in the database yet (code deployed before the migration). */
  notDeployed: boolean
}

export interface DispatchOptions {
  supabase: SupabaseClient
  batchSize?: number
  /** Claim round trips at most; the kick makes one. */
  maxBatches?: number
  budgetMs?: number
  now?: () => number
}

/**
 * PostgREST and Postgres codes for an outbox function or table that does not
 * exist: the migrations 20261017120000/120100 are not applied yet. Code may
 * reach an environment before its migration, so this is a skip, not a failure.
 */
const NOT_DEPLOYED_CODES = new Set(['PGRST202', 'PGRST205', '42883', '42P01'])

export function isOutboxNotDeployed(error: { code?: string | null } | null | undefined): boolean {
  return !!error && NOT_DEPLOYED_CODES.has(error.code ?? '')
}

export class OutboxError extends Error {
  readonly code: string | undefined
  constructor(step: string, error: { code?: string | null; message?: string }) {
    super(`event outbox ${step} failed: ${error.message ?? 'unknown error'}${error.code ? ` (${error.code})` : ''}`)
    this.name = 'OutboxError'
    this.code = error.code ?? undefined
  }
}

/**
 * Run one dispatch cycle: claim and finish until a claim comes back short,
 * maxBatches round trips were made or the budget is spent. Throws an
 * OutboxError when a claim or a finish fails for any reason other than the
 * outbox not being deployed; claimed deliveries left unfinished are claimed
 * again when their lease runs out.
 */
export async function dispatchEventOutbox(options: DispatchOptions): Promise<OutboxDispatchSummary> {
  if (eventOutboxMode() === 'off') return claimAndFinish(options)

  const lastAttempt = await deliveriesOnLastAttempt(options.supabase)
  let summary: OutboxDispatchSummary | undefined
  try {
    summary = await claimAndFinish(options)
    return summary
  } finally {
    // Also after a claim or finish that threw: the deliveries the claims of
    // this cycle took dead are no longer live, so no later cycle finds them.
    const dead = await reportDeadOnLeaseExpiry(options.supabase, lastAttempt)
    if (summary) summary.deadOnLeaseExpiry = dead
  }
}

async function claimAndFinish(options: DispatchOptions): Promise<OutboxDispatchSummary> {
  const mode = eventOutboxMode()
  const summary: OutboxDispatchSummary = {
    mode,
    batches: 0,
    claimed: 0,
    completed: 0,
    ran: 0,
    retried: 0,
    dead: 0,
    deadOnLeaseExpiry: 0,
    oldestAgeMs: null,
    notDeployed: false,
  }
  if (mode === 'off') return summary

  const { supabase } = options
  const batchSize = options.batchSize ?? DISPATCH_BATCH_SIZE
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY
  const budgetMs = options.budgetMs ?? DISPATCH_BUDGET_MS
  const now = options.now ?? Date.now
  const started = now()

  while (summary.batches < maxBatches && now() - started < budgetMs) {
    const { data, error } = await supabase.rpc('claim_event_deliveries', {
      p_limit: batchSize,
      p_lease_seconds: DISPATCH_LEASE_SECONDS,
      p_max_attempts: DISPATCH_MAX_ATTEMPTS,
    })
    if (error) {
      if (isOutboxNotDeployed(error)) {
        summary.notDeployed = true
        break
      }
      throw new OutboxError('claim', error)
    }
    summary.batches++
    const rows = (data ?? []) as ClaimedDelivery[]
    if (rows.length === 0) break
    summary.claimed += rows.length

    const claimedAt = now()
    for (const row of rows) {
      const age = claimedAt - Date.parse(row.created_at)
      if (Number.isFinite(age) && (summary.oldestAgeMs === null || age > summary.oldestAgeMs)) {
        summary.oldestAgeMs = Math.max(0, age)
      }
    }

    // Deferred deliveries run their consumer; every other one already ran
    // inline in the emitting request (shadow) and is only marked done.
    const deferred = rows.filter((row) => row.inline_result === 'deferred')
    const finished = rows.filter((row) => row.inline_result !== 'deferred')
    const failures: Array<{ row: ClaimedDelivery; error: string }> = []
    const outcomes = await runBounded(deferred, ASYNC_CONCURRENCY, (row) => runDeferred(supabase, row))
    summary.ran += deferred.filter((row) => ASYNC_BY_ID.has(row.consumer_id)).length
    deferred.forEach((row, i) => {
      const outcome = outcomes[i]
      if (outcome === null) finished.push(row)
      else failures.push({ row, error: outcome })
    })

    if (finished.length > 0) {
      const { data: completed, error: completeError } = await supabase.rpc('complete_event_deliveries', {
        p_outbox_ids: finished.map((row) => row.outbox_id),
        p_consumer_ids: finished.map((row) => row.consumer_id),
        p_attempts: finished.map((row) => row.attempts),
      })
      if (completeError) throw new OutboxError('complete', completeError)
      summary.completed += typeof completed === 'number' ? completed : 0
    }

    for (const { row, error } of failures) {
      const { data: status, error: failError } = await supabase.rpc('fail_event_delivery', {
        p_outbox_id: row.outbox_id,
        p_consumer_id: row.consumer_id,
        p_attempt: row.attempts,
        p_error: error.slice(0, 1000),
        p_retry_after_seconds: retryAfterSeconds(row.attempts),
        p_max_attempts: DISPATCH_MAX_ATTEMPTS,
      })
      if (failError) throw new OutboxError('fail', failError)
      if (status === 'dead') summary.dead++
      else if (status === 'pending') summary.retried++
      const fields = {
        outboxId: row.outbox_id,
        consumerId: row.consumer_id,
        eventType: row.event_type,
        companyId: row.company_id ?? undefined,
        attempt: row.attempts,
        status,
        error,
      }
      if (status === 'dead') log.error('event outbox delivery dead', new Error(error), fields)
      else if (status === 'pending') log.warn('event outbox delivery failed; retried after backoff', fields)
      // lease_lost: the lease ran out mid-run and a newer claim owns the delivery.
      else log.warn('event outbox delivery failed after its claim was lost; the newer claim owns it', fields)
    }

    if (rows.length < batchSize) break
  }

  return summary
}

/** What claim_event_deliveries writes on a delivery it takes dead (migration 20261018110300). */
const LEASE_EXPIRED_ERROR = 'lease expired on the last attempt'

interface DeliveryKey {
  outbox_id: number
  consumer_id: string
}

/**
 * The claimed deliveries on their last attempt: the only ones the next claim
 * can take dead (when their lease has run out). Normally none. Read through
 * the partial index of live deliveries. Best effort: a failed read is a
 * warning and reports nothing, it never stops the dispatch.
 */
async function deliveriesOnLastAttempt(supabase: SupabaseClient): Promise<DeliveryKey[]> {
  const { data, error } = await supabase
    .from('event_deliveries')
    .select('outbox_id, consumer_id')
    .eq('status', 'claimed')
    .gte('attempts', DISPATCH_MAX_ATTEMPTS)
    .order('outbox_id', { ascending: true })
    .limit(DISPATCH_BATCH_SIZE)
  if (error) {
    if (!isOutboxNotDeployed(error)) log.warn('event outbox last-attempt read failed', { code: error.code })
    return []
  }
  return (data ?? []) as DeliveryKey[]
}

/**
 * Log, once each, the deliveries of `candidates` that a claim of this cycle
 * took dead: they are dead with the claim's own error text. A delivery that
 * died in fail_event_delivery carries another text and was logged there.
 * Answers how many.
 */
async function reportDeadOnLeaseExpiry(supabase: SupabaseClient, candidates: DeliveryKey[]): Promise<number> {
  if (candidates.length === 0) return 0
  const { data, error } = await supabase
    .from('event_deliveries')
    .select('outbox_id, consumer_id, attempts')
    .in('outbox_id', [...new Set(candidates.map((c) => c.outbox_id))])
    .eq('status', 'dead')
    .eq('last_error', LEASE_EXPIRED_ERROR)
  if (error) {
    log.warn('event outbox dead-on-lease-expiry read failed', { code: error.code })
    return 0
  }
  const wanted = new Set(candidates.map((c) => `${c.outbox_id}:${c.consumer_id}`))
  const dead = ((data ?? []) as Array<DeliveryKey & { attempts: number }>).filter((row) =>
    wanted.has(`${row.outbox_id}:${row.consumer_id}`),
  )
  for (const row of dead) {
    log.error('event outbox delivery dead', new Error(LEASE_EXPIRED_ERROR), {
      outboxId: row.outbox_id,
      consumerId: row.consumer_id,
      attempt: row.attempts,
      status: 'dead',
      error: LEASE_EXPIRED_ERROR,
    })
  }
  return dead.length
}

/**
 * Run one deferred delivery's consumer. Answers null on success, or why it
 * failed: the consumer threw or timed out, or this code has no async
 * consumer by that id.
 */
async function runDeferred(supabase: SupabaseClient, row: ClaimedDelivery): Promise<string | null> {
  const consumer = ASYNC_BY_ID.get(row.consumer_id)
  if (!consumer) return `no async consumer '${row.consumer_id}' in this deployment`

  const event = { type: row.event_type, payload: row.payload } as CoreEvent
  if (!consumer.eventTypes.includes(event.type)) {
    return `consumer '${row.consumer_id}' does not handle ${row.event_type}`
  }
  const ctx: EventConsumerContext = Object.freeze({
    consumerId: consumer.id,
    outbox: Object.freeze({ outboxId: Number(row.outbox_id), attempt: row.attempts, supabase }),
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => consumer.handle(event, ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${HANDLER_TIMEOUT_MS} ms`)), HANDLER_TIMEOUT_MS)
      }),
    ])
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Map items through fn, at most `limit` at a time, answers in input order. */
async function runBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
