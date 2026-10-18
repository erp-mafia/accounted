/**
 * The event outbox writer and its dispatch kick (step E2: shadow mode).
 *
 * lib/init installs writeShadowDeliveries on the event bus
 * (installEventOutbox). With EVENT_OUTBOX_MODE=shadow the bus calls it once
 * per emitted event that has an outbox consumer, after every handler has
 * settled inline: one enqueue_event RPC writes the event and one delivery per
 * consumer, with what that consumer did inline (event_deliveries.
 * inline_result). With the mode off (the default) the bus never calls it.
 *
 * The writer throws on any failure, including an outbox not deployed yet;
 * the bus logs it ('event outbox shadow enqueue failed') and goes on, so the
 * emitter never sees it. The enqueue is bounded by ENQUEUE_TIMEOUT_MS: in
 * shadow mode it is on the emit's path, which the routes await.
 *
 * After an enqueue that wrote something, one dispatch cycle is scheduled to
 * run after the response (next/server after()), coalesced per instance, as
 * the webhook dispatch kick does (lib/webhooks/dispatch-kick.ts): it moves
 * the first claim forward from the per-minute cron to seconds. For a
 * delivery the bus deferred (EVENT_DELIVERY_WEBHOOKS=outbox, step E3) that
 * cycle is what runs the consumer, so a webhook still leaves seconds after
 * the request. Never awaited by the emitter and never throws.
 */
import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { createLogger } from '@/lib/logger'
import { eventBus, type ShadowDelivery } from './bus'
import { dispatchEventOutbox, OutboxError } from './outbox-dispatcher'
import type { CoreEvent } from './types'

const log = createLogger('event-outbox')

/** Bound on the enqueue round trip, which shadow mode adds to every emit with an outbox consumer. */
export const ENQUEUE_TIMEOUT_MS = 3000

/** Deliveries claimed by an emit-triggered cycle: one round trip, the cron takes the rest. */
export const KICK_BATCH_SIZE = 50

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Install the writer on the event bus. Called by lib/init; idempotent. */
export function installEventOutbox(): void {
  eventBus.setOutboxWriter(writeShadowDeliveries)
}

/** The service-role client the outbox runs on, or null without a Supabase configuration. */
export function outboxServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || url.startsWith('__')) return null
  return createServiceRoleClient(url, key)
}

/**
 * Enqueue the event for these deliveries (one enqueue_event call). The
 * company is the payload's companyId when it is a uuid. Throws on failure.
 */
export async function writeShadowDeliveries(event: CoreEvent, deliveries: readonly ShadowDelivery[]): Promise<void> {
  if (deliveries.length === 0) return
  const supabase = outboxServiceClient()
  if (!supabase) throw new Error('event outbox enqueue failed: no Supabase service configuration')

  const payload = event.payload as Record<string, unknown>
  const companyId = typeof payload.companyId === 'string' && UUID_RE.test(payload.companyId) ? payload.companyId : null

  const { data, error } = await supabase
    .rpc('enqueue_event', {
      p_event_type: event.type,
      p_company_id: companyId,
      p_payload: event.payload,
      p_consumer_ids: deliveries.map((delivery) => delivery.consumerId),
      p_inline_results: Object.fromEntries(deliveries.map((delivery) => [delivery.consumerId, delivery.inline])),
    })
    .abortSignal(AbortSignal.timeout(ENQUEUE_TIMEOUT_MS))
  if (error) throw new OutboxError('enqueue', error)

  // NULL: nothing was written (a dedupe key already in the outbox).
  if (data !== null && data !== undefined) kickEventOutboxDispatch()
}

/**
 * True while a kick is scheduled but has not started. Module scope: per
 * function instance, so concurrent instances each get one (their claims are
 * disjoint).
 */
let kickPending = false

type DispatchFn = typeof dispatchEventOutbox

/** Schedule one dispatch cycle after the current response. Returns at once. */
export function kickEventOutboxDispatch(dispatchImpl: DispatchFn = dispatchEventOutbox): void {
  if (kickPending) return
  kickPending = true

  const run = async (): Promise<void> => {
    // Cleared first: a kick scheduled while this cycle runs gets its own slot,
    // and a cycle that dies cannot wedge the flag on.
    kickPending = false
    try {
      const supabase = outboxServiceClient()
      if (!supabase) return
      await dispatchImpl({ supabase, batchSize: KICK_BATCH_SIZE, maxBatches: 1 })
    } catch (err) {
      // The cron claims every delivery this kick did not finish.
      log.warn('emit-triggered event outbox dispatch failed; the cron will retry', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    after(() => run())
  } catch {
    // Outside a request scope (a script, a unit test): a floating promise,
    // deferred so a synchronous burst still coalesces.
    queueMicrotask(() => void run())
  }
}

/** Test-only: reset the coalescing flag between cases. */
export function resetOutboxKickForTests(): void {
  kickPending = false
}
