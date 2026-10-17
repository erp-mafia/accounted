/**
 * The event outbox dispatcher (step E2: shadow mode).
 *
 * Claims due deliveries from event_deliveries (claim_event_deliveries: FOR
 * UPDATE SKIP LOCKED, a lease, the attempt count as fencing token) and
 * finishes them. In shadow mode every consumer has already run inline in the
 * request that emitted the event, so nothing runs here: each claimed delivery
 * is marked done (complete_event_deliveries). What the cycle measures (how
 * many, how old the oldest was when claimed) is the latency an async
 * consumer would see.
 *
 * With EVENT_OUTBOX_MODE off it does nothing at all. Step E3 runs the
 * consumer of each delivery flipped to async here instead of marking it done,
 * finishing it with complete_event_deliveries or fail_event_delivery.
 *
 * Two callers: the per-minute cron (/api/events/dispatch/cron) and the kick
 * after an emit that enqueued something (lib/events/outbox.ts). SKIP LOCKED
 * keeps their claims disjoint.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventOutboxMode, type EventOutboxMode } from './consumer-index'

/** Deliveries claimed per round trip by the cron. */
export const DISPATCH_BATCH_SIZE = 200

/** How long a claim owns its deliveries before another dispatcher may take them. */
export const DISPATCH_LEASE_SECONDS = 60

/** Claims a delivery gets before an expired lease makes it dead. */
export const DISPATCH_MAX_ATTEMPTS = 8

/** Wall-clock budget of one cycle: well inside the cron route's maxDuration. */
export const DISPATCH_BUDGET_MS = 25_000

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
}

export interface OutboxDispatchSummary {
  mode: EventOutboxMode
  /** Claim round trips made. */
  batches: number
  claimed: number
  completed: number
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
  const mode = eventOutboxMode()
  const summary: OutboxDispatchSummary = {
    mode,
    batches: 0,
    claimed: 0,
    completed: 0,
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

    // Shadow: every consumer already ran inline in the emitting request.
    // Nothing runs here; the delivery is done.
    const { data: completed, error: completeError } = await supabase.rpc('complete_event_deliveries', {
      p_outbox_ids: rows.map((row) => row.outbox_id),
      p_consumer_ids: rows.map((row) => row.consumer_id),
      p_attempts: rows.map((row) => row.attempts),
    })
    if (completeError) throw new OutboxError('complete', completeError)
    summary.completed += typeof completed === 'number' ? completed : 0

    if (rows.length < batchSize) break
  }

  return summary
}
