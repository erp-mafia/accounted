/**
 * Which event consumers react to which event type, as data: the consumer ids
 * of lib/composition/event-consumers.ts (EVENT_CONSUMERS) and of every
 * extension with event handlers in extensions.config.json (`ext:<id>`,
 * lib/extensions/registry.ts), per event type in dispatch order.
 *
 * The event bus reads it to know which consumers an event is enqueued for in
 * the event outbox (lib/events/outbox.ts), without importing a single handler:
 * bus.ts is in the graph of every server entry, and the consumer list itself
 * imports every handler module. So this module imports no handler, no
 * composition module and nothing of lib/init; only the generated list of
 * enabled extension ids, which is data too.
 *
 * Kept by hand. consumer-index.test.ts fails when it drifts from the
 * consumers lib/init subscribes (the declared consumers and
 * subscriptions.fixture.json): add a consumer there and here together.
 *
 * Also here, because the bus reads them and may import nothing else:
 * EVENT_OUTBOX_MODE (eventOutboxMode below) and the per-consumer delivery
 * switches (eventDelivery below).
 */
import type { CoreEventType } from './types'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

const INDEX: Partial<Record<CoreEventType, readonly string[]>> = {
  'agent.feedback': ['event-log', 'agent-feedback-relay'],
  'agi.generated': ['event-log', 'webhooks'],
  'article.deleted': ['event-log'],
  'bank_connection.account_selection_changed': ['event-log'],
  'bank_connection.consent_denied': ['event-log'],
  'bank_connection.consent_granted': ['event-log'],
  'bank_connection.finalize_failed': ['event-log'],
  'bank_connection.revoked': ['event-log'],
  'bank_connection.superseded': ['event-log'],
  'bank_connection.sync_failed': ['event-log'],
  'company.accounting_framework_changed': ['event-log'],
  'company.deleted': ['deleted-company-bank-feeds'],
  'credit_note.created': ['event-log', 'webhooks', 'ext:stripe'],
  'customer.created': ['event-log', 'webhooks'],
  'dimension_value.archived': ['event-log', 'webhooks'],
  'dimension_value.created': ['event-log', 'webhooks'],
  'dimension_value.renamed': ['event-log', 'webhooks'],
  'dimension_value.unarchived': ['event-log', 'webhooks'],
  'document.accessed': ['event-log'],
  'document.classified': ['ext:invoice-inbox'],
  'document.deleted': ['event-log'],
  'document.uploaded': ['event-log', 'document-read', 'webhooks', 'ext:document-extraction'],
  'employee.created': ['suggestion-detectors'],
  'invoice.cancelled': ['event-log'],
  'invoice.created': ['event-log', 'webhooks'],
  'invoice.draft_deleted': ['event-log'],
  'invoice.match_confirmed': ['event-log'],
  'invoice.paid': ['event-log', 'webhooks', 'ext:stripe'],
  'invoice.sent': ['event-log', 'webhooks'],
  'journal_entry.committed': ['event-log', 'webhooks'],
  'journal_entry.corrected': ['unlearn-on-reversal', 'event-log', 'webhooks'],
  'journal_entry.reversed': ['unlearn-on-reversal', 'accrual-origin-reversal', 'event-log', 'webhooks'],
  'mcp.next_hint_followed': ['event-log'],
  'mcp.resource_read': ['event-log'],
  'mcp.skill_loaded': ['event-log'],
  'mcp.skill_not_found': ['event-log'],
  'mcp.tool_called': ['event-log'],
  'mcp.tool_searched': ['event-log'],
  'mcp.tools_list_called': ['event-log'],
  'mcp.workflow_started': ['event-log'],
  'period.lock_date_changed': ['event-log', 'webhooks'],
  'period.locked': ['event-log', 'webhooks'],
  'period.unlocked': ['event-log', 'webhooks'],
  'period.year_closed': ['event-log', 'webhooks'],
  'pos.connected': ['suggestion-detectors'],
  'reconciliation.matched': ['event-log', 'webhooks'],
  'reconciliation.reopened': ['event-log', 'webhooks'],
  'reconciliation.signed_off': ['event-log', 'webhooks'],
  'reconciliation.unmatched': ['event-log', 'webhooks'],
  'salary_run.approved': ['event-log', 'webhooks'],
  'salary_run.booked': ['event-log', 'webhooks'],
  'salary_run.created': ['event-log', 'webhooks'],
  'shopify.connected': ['suggestion-detectors'],
  'signing.cancelled': ['event-log'],
  'signing.completed': ['event-log', 'webhooks'],
  'signing.declined': ['event-log', 'webhooks'],
  'signing.requested': ['event-log'],
  'signing.signer_signed': ['event-log', 'webhooks'],
  'supplier.created': ['event-log', 'webhooks'],
  'supplier_invoice.approved': ['supplier-invoice-retro-match', 'event-log', 'webhooks'],
  'supplier_invoice.confirmed': ['event-log'],
  'supplier_invoice.credited': ['event-log', 'webhooks'],
  'supplier_invoice.match_confirmed': ['event-log', 'inbox-receipt-follow'],
  'supplier_invoice.paid': ['event-log', 'webhooks'],
  'supplier_invoice.registered': ['supplier-invoice-retro-match', 'attest-notify', 'event-log', 'webhooks', 'suggestion-detectors'],
  'supplier_invoice.uncredited': ['event-log', 'webhooks'],
  'transaction.categorized': ['event-log', 'webhooks', 'suggestion-detectors'],
  'transaction.reconciled': ['event-log', 'webhooks'],
  'transaction.synced': ['event-log', 'inbox-bank-match', 'forecast-realise'],
  'woocommerce.connected': ['suggestion-detectors'],
  'zettle.connected': ['suggestion-detectors'],
}

export const EVENT_CONSUMER_INDEX: Readonly<Partial<Record<CoreEventType, readonly string[]>>> = Object.freeze(INDEX)

/**
 * Consumers that run inline in the emitting request for good and are never
 * delivered from the outbox: event_log persistence stays synchronous (it is
 * what GET /api/events serves the moment the request answers).
 */
export const INLINE_ONLY_CONSUMERS: ReadonlySet<string> = new Set(['event-log'])

const outboxIdsByType = new Map<string, readonly string[]>()

/**
 * The consumers an event of this type is enqueued for in the outbox: the
 * index's consumers without the inline-only ones and without the consumers
 * of extensions this installation does not run. Empty for a type no such
 * consumer reacts to.
 */
export function outboxConsumerIds(eventType: string): readonly string[] {
  let ids = outboxIdsByType.get(eventType)
  if (!ids) {
    const indexed = (EVENT_CONSUMER_INDEX as Readonly<Record<string, readonly string[]>>)[eventType] ?? []
    ids = Object.freeze(
      indexed.filter(
        (id) => !INLINE_ONLY_CONSUMERS.has(id) && (!id.startsWith('ext:') || ENABLED_EXTENSION_IDS.has(id.slice(4))),
      ),
    )
    outboxIdsByType.set(eventType, ids)
  }
  return ids
}

/** Whether the index lists this consumer for this event type (extensions not filtered). */
export function isIndexedConsumer(eventType: string, consumerId: string): boolean {
  const indexed = (EVENT_CONSUMER_INDEX as Readonly<Record<string, readonly string[]>>)[eventType]
  return indexed !== undefined && indexed.includes(consumerId)
}

/**
 * EVENT_OUTBOX_MODE:
 *   off     (the default, also for an unset or unknown value) the outbox is
 *           not touched: every consumer runs inline and nothing else happens.
 *   shadow  every consumer still runs inline exactly as with off; the bus
 *           also enqueues each event for its outbox consumers after the
 *           handlers settled, and the dispatcher marks the deliveries done
 *           without running anything. For comparing the two (step E2).
 *           The one exception is a consumer whose own switch says outbox
 *           (eventDelivery below, step E3): it is deferred to the outbox
 *           instead of run inline, and the dispatcher runs it.
 * Read on every call, so a test or a redeploy changes it without a restart.
 */
export type EventOutboxMode = 'off' | 'shadow'

export function eventOutboxMode(): EventOutboxMode {
  return process.env.EVENT_OUTBOX_MODE?.trim().toLowerCase() === 'shadow' ? 'shadow' : 'off'
}

/**
 * The consumers that can be delivered from the outbox instead of inline
 * (step E3), each with the environment variable that switches it. The outbox
 * dispatcher runs exactly these (ASYNC_EVENT_CONSUMERS,
 * lib/composition/async-event-consumers.ts; consumer-index.test.ts keeps the
 * two equal). Webhooks only: one consumer at a time, each with its own
 * idempotency key.
 */
export const ASYNC_CONSUMER_SWITCHES: Readonly<Record<string, string>> = Object.freeze({
  webhooks: 'EVENT_DELIVERY_WEBHOOKS',
})

/**
 * A consumer's delivery switch, EVENT_DELIVERY_<CONSUMER>:
 *   inline  (the default, also for an unset or unknown value, and for every
 *           consumer without a switch) the consumer runs in the emitting
 *           request, as before step E3.
 *   outbox  with EVENT_OUTBOX_MODE=shadow, the bus does not run the consumer
 *           inline: it enqueues its delivery as 'deferred' and the outbox
 *           dispatcher runs it. With the outbox mode off the switch is
 *           ignored and the consumer stays inline (the bus logs that once).
 * Read on every call: the bus decides per event, on the instance that emits
 * it, and records the decision in the delivery (inline_result 'deferred'),
 * so a rolling deploy or a switch flipped back never runs one event both
 * inline and from the queue.
 */
export type EventDelivery = 'inline' | 'outbox'

export function eventDelivery(consumerId: string): EventDelivery {
  if (!Object.hasOwn(ASYNC_CONSUMER_SWITCHES, consumerId)) return 'inline'
  const value = process.env[ASYNC_CONSUMER_SWITCHES[consumerId]]
  return value?.trim().toLowerCase() === 'outbox' ? 'outbox' : 'inline'
}

/** The consumers whose switch says outbox, whatever the outbox mode. */
export function outboxSwitchedConsumerIds(): string[] {
  return Object.keys(ASYNC_CONSUMER_SWITCHES).filter((consumerId) => eventDelivery(consumerId) === 'outbox')
}
