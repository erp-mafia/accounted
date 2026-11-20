/**
 * Webhook event-bus handler.
 *
 * Subscribes to every CoreEventType the v1 API surface emits and converts
 * each emission into N rows in `webhook_deliveries`: one per active webhook
 * of the company whose event_types lists the emitted type (a subscription
 * carries one or more types, migration 20261016001000). A dispatch cycle is then scheduled
 * immediately (see dispatch-kick.ts); the per-minute cron stays as the retry
 * and sweep path.
 *
 * Wired by lib/init through the webhooks consumer in
 * lib/composition/event-consumers.ts; instrumentation.ts registers the loader
 * of lib/init and the bus waits for it before the first event of a process
 * (lib/initialized.ts), exactly once.
 *
 * Design notes:
 *   - We do NOT block the emitting route on delivery insert: the handler
 *     runs inside Promise.allSettled in the bus (see lib/events/bus.ts), so
 *     a DB insert failure is logged but doesn't crash the emitter.
 *   - We capture `previous_attributes` only for events whose payload carries
 *     both a prior and current shape. Phase 6 PR-1 emits null for everything:
 *     adding the diff is a follow-up that requires touching each route's
 *     emit() call site to capture the prior row.
 *   - Service-role client because this code runs from the bus, outside any
 *     authenticated Supabase context.
 *   - From the event outbox (EVENT_DELIVERY_WEBHOOKS=outbox, step E3) the
 *     dispatcher calls fanOutEvent with the delivery: it runs on the
 *     dispatcher's client, writes each row with the event's outbox id and
 *     inserts or ignores on (webhook_id, outbox_id), so a delivery the outbox
 *     runs twice (at least once: a crash after the fan-out, an expired lease)
 *     fans out once; and it throws on a failure, so the outbox retries it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import type { OutboxDeliveryContext } from '@/lib/events/consumers'
import type { CoreEventType } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { kickWebhookDispatch } from './dispatch-kick'
import { PUBLIC_WEBHOOK_EVENTS as PUBLIC_WEBHOOK_EVENT_CATALOGUE } from './public-events'
import { verificationAllowsDelivery } from './verification'

const log = createLogger('webhooks/handler')

/**
 * Set of event types that the v1 webhook surface delivers. Derived from the
 * public catalogue in ./public-events.ts, which is also what the v1 create
 * schema and the docs page enumerate: add new event types THERE, not here.
 */
const PUBLIC_WEBHOOK_EVENTS = new Set<CoreEventType>(PUBLIC_WEBHOOK_EVENT_CATALOGUE)

/** The event types the webhook consumer subscribes to, once each. */
export const WEBHOOK_EVENT_TYPES: readonly CoreEventType[] = [...PUBLIC_WEBHOOK_EVENTS]

let registered = false

/**
 * Subscribe the webhook handler to every event in PUBLIC_WEBHOOK_EVENTS.
 * Idempotent. lib/init subscribes the same handler through EVENT_CONSUMERS
 * (lib/composition/event-consumers.ts) instead.
 */
export function registerWebhookHandler(): void {
  if (registered) return
  registered = true

  for (const eventType of PUBLIC_WEBHOOK_EVENTS) {
    eventBus.on(eventType, (payload) => fanOutEvent(eventType, payload))
  }

  log.info('webhook handler registered', { eventCount: PUBLIC_WEBHOOK_EVENTS.size })
}

/**
 * The handler for one PUBLIC_WEBHOOK_EVENTS event: one webhook_deliveries row
 * per matching webhook of the company. lib/init subscribes it through
 * EVENT_CONSUMERS (lib/composition/event-consumers.ts).
 *
 * Inline (no outbox delivery): never throws, as before step E3. From the
 * outbox: keyed by outbox.outboxId (insert or ignore per webhook) and throws
 * when the lookup or the insert fails, so the dispatcher retries the
 * delivery; an event without a company is logged and finished, since no
 * retry can give it one.
 */
export async function fanOutEvent(
  eventType: CoreEventType,
  payload: unknown,
  outbox?: OutboxDeliveryContext,
): Promise<void> {
  // payload type depends on eventType but every variant carries
  // companyId: the only field we structurally need here.
  const companyId = (payload as { companyId?: string }).companyId
  if (!companyId) {
    // Surface as an error: every CoreEvent payload variant types
    // companyId as required, so a missing value indicates an emit-site
    // bug that silently breaks webhook delivery for that event. Logging
    // at error level ensures it shows up in monitoring rather than
    // disappearing into routine warn-noise.
    log.error('event missing companyId: webhook fanout skipped', new Error('missing companyId'), { eventType })
    return
  }

  try {
    await fanOutToWebhooks({
      eventType,
      companyId,
      payload: minimisePayload(payload as Record<string, unknown>),
      outbox,
    })
  } catch (err) {
    if (outbox) throw err
    log.error('webhook fanout failed', err as Error, { eventType, companyId })
  }
}

/** A fan-out from the outbox that failed and is to be retried. */
export class WebhookFanOutError extends Error {
  readonly code: string | undefined
  constructor(step: 'lookup' | 'insert', error: { code?: string | null; message?: string }) {
    super(`webhook fanout ${step} failed: ${error.message ?? 'unknown error'}${error.code ? ` (${error.code})` : ''}`)
    this.name = 'WebhookFanOutError'
    this.code = error.code ?? undefined
  }
}

/**
 * Keys dropped from an outbound event payload at any depth. Emit sites pass
 * whole rows with their joins (invoice.created carries `customer:customers(*)`
 * and the items), so a top-level check misses the nested copies.
 *   - userId / user_id: internal Supabase auth.users.id UUIDs that identify
 *     the Accounted-side actor, not the resource. companyId stays (it is the
 *     tenant scope, useful for multi-tenant receivers).
 *   - personnummer in every stored form: the customer's personal_number, the
 *     ROT/RUT claimant's ciphertext and last four digits on the invoice, and
 *     the employee's ciphertext and last four digits.
 *   - keepLearnedTemplates: an in-process instruction to the template
 *     consumer on journal_entry.corrected, not part of the event.
 */
const STRIPPED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'userId',
  'user_id',
  'personal_number',
  'personnummer',
  'deduction_personnummer_encrypted',
  'deduction_personnummer_last4',
  'personnummer_encrypted',
  'personnummer_last4',
  'keepLearnedTemplates',
])

/**
 * Drop fields from the in-process event payload that have no value to an
 * external receiver (STRIPPED_PAYLOAD_KEYS), recursing into nested objects
 * and arrays. Returns a copy: the in-process payload other bus handlers read
 * is left untouched.
 *
 * Every outbound surface runs this one projection (the webhook fan-out, the
 * webhook retry and GET /api/events), so a tightening lands in one place
 * rather than per emit site. GDPR Art.5(1)(c) data minimisation.
 */
export function minimisePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return minimiseValue(payload) as Record<string, unknown>
}

function minimiseValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(minimiseValue)
  if (!isPlainObject(value)) return value
  const projected: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (STRIPPED_PAYLOAD_KEYS.has(key)) continue
    projected[key] = minimiseValue(child)
  }
  return projected
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Look up the company's active webhooks that list eventType and insert one
 * webhook_deliveries row per match. Pending rows are picked up by the
 * dispatcher cron at next-minute boundary. From the outbox: on its client,
 * keyed by the outbox id, and a lookup or insert failure throws.
 */
async function fanOutToWebhooks(args: {
  eventType: string
  companyId: string
  payload: Record<string, unknown>
  outbox?: OutboxDeliveryContext
}): Promise<void> {
  const { outbox } = args
  const supabase: SupabaseClient = outbox?.supabase ?? createServiceClientNoCookies()

  const { data: found, error: fetchErr } = await supabase
    .from('webhooks')
    .select('id, api_version_pinned, verified_at, verification_grace_ends_at')
    .eq('company_id', args.companyId)
    // event_types @> {eventType}: a subscription matches any type it lists.
    // The sync trigger fills event_types for writers that set only the
    // legacy event_type, so no OR over the single column is needed.
    .contains('event_types', [args.eventType])
    .eq('active', true)
    .is('disabled_at', null)

  if (fetchErr) {
    log.error('webhook lookup failed', fetchErr as Error, {
      companyId: args.companyId,
      eventType: args.eventType,
    })
    if (outbox) throw new WebhookFanOutError('lookup', fetchErr)
    return
  }
  // Ownership gate (ADA CASA 7.1.2): nothing is enqueued for an endpoint that
  // has not passed the verification handshake, unless it predates
  // verification and is still inside its grace window
  // (lib/webhooks/verification.ts). Events are not parked for later either: a
  // pending or paused endpoint is treated like a disabled one.
  const now = new Date()
  const webhooks = (found ?? []).filter((w) =>
    verificationAllowsDelivery(
      w as { verified_at: string | null; verification_grace_ends_at: string | null },
      now,
    ),
  )
  if (webhooks.length === 0) return

  // Synthesise a correlation id for the fanout batch. The event bus is
  // async: by the time we reach here the originating route's request
  // context is gone, so we can't recover the live request_id. A fresh
  // 'whfan_<uuid>' keeps the BFNAR 2013:2 kap 8 § behandlingshistorik
  // requirement satisfied (the column is never NULL on a fresh insert)
  // and lets a per-fanout audit query group the rows that came from the
  // same emission. Threading the originating request_id into the event
  // payload itself is a future-direction improvement.
  const fanoutId = `whfan_${crypto.randomUUID()}`

  const rows = webhooks.map((w) => ({
    webhook_id: (w as { id: string }).id,
    company_id: args.companyId,
    event_type: args.eventType,
    payload: args.payload,
    api_version: (w as { api_version_pinned: string }).api_version_pinned ?? API_V1_VERSION,
    // previous_attributes is null in Phase 6 PR-1; populated in a follow-up
    // when each route's emit() call captures the prior row.
    previous_attributes: null,
    request_id: fanoutId,
  }))

  // From the outbox: insert or ignore on (webhook_id, outbox_id), the unique
  // key of migration 20261018110200, so a rerun of the same outbox delivery
  // adds no second row for a webhook that already has one. Inline rows never
  // name outbox_id: code can be live before that migration is.
  const { error: insertErr } = outbox
    ? await supabase.from('webhook_deliveries').upsert(
        rows.map((row) => ({
          webhook_id: row.webhook_id,
          company_id: row.company_id,
          event_type: row.event_type,
          payload: row.payload,
          api_version: row.api_version,
          previous_attributes: row.previous_attributes,
          request_id: row.request_id,
          outbox_id: outbox.outboxId,
        })),
        { onConflict: 'webhook_id,outbox_id', ignoreDuplicates: true },
      )
    : await supabase.from('webhook_deliveries').insert(rows)
  if (insertErr) {
    log.error('webhook_deliveries insert failed', insertErr as Error, {
      companyId: args.companyId,
      eventType: args.eventType,
      webhookCount: rows.length,
    })
    if (outbox) throw new WebhookFanOutError('insert', insertErr)
    return
  }

  // Deliver now instead of waiting for the next cron tick (#1201). Scheduled,
  // never awaited: see lib/webhooks/dispatch-kick.ts for why the emitter must
  // not block on a receiver's HTTP endpoint.
  kickWebhookDispatch()
}
