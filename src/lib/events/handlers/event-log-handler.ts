import { eventBus } from '@/lib/events/bus'
import type { CoreEventType } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { PUBLIC_WEBHOOK_EVENTS } from '@/lib/webhooks/public-events'
import { eventDedupeKey } from '@/lib/events/dedupe-key'

const log = createLogger('event-log')

/**
 * Persisted event types that are NOT in the public webhook catalogue: internal
 * lifecycle events external automation still polls, MCP telemetry, agent
 * feedback and the bank-consent audit trail. Every public event is persisted
 * anyway (PERSISTED_EVENT_TYPES below): never list a catalogue event here.
 */
const INTERNAL_PERSISTED_EVENT_TYPES: CoreEventType[] = [
  // BankID signing: when a document was sent for signing and when a request
  // was cancelled (the signatures and the outcome are public events).
  'signing.requested',
  'signing.cancelled',
  'document.accessed',
  'document.deleted',
  'invoice.draft_deleted',
  'invoice.cancelled',
  // Ångra kreditering: who undid a credit, and on what basis (lib/invoices/uncredit-invoice.ts).
  'invoice.uncredited',
  'transaction.synced',
  'article.deleted',
  'invoice.match_confirmed',
  'supplier_invoice.match_confirmed',
  'supplier_invoice.confirmed',
  // MCP telemetry: every tool invocation, tools/list call, and resources/read.
  // Lightweight metadata only. mcp.*/agent.* rows are retained 180 days by the
  // cleanup cron, then kept only as anonymous daily counts; every other event
  // type is kept.
  'mcp.tool_called',
  'mcp.tools_list_called',
  'mcp.resource_read',
  // Workflow lifecycle + next-hint follow-through (Phase 3A). Tells us where
  // agents stall, which skills actually drive completion, and whether the
  // next-field rollout is paying off.
  'mcp.workflow_started',
  'mcp.next_hint_followed',
  // Every successful gnubok_load_skill, all tiers: which atoms agents
  // actually load. Joined against mcp.tool_called error rates to measure
  // whether a loaded atom helps or hurts.
  'mcp.skill_loaded',
  // gnubok_load_skill calls whose slug matched nothing, and every
  // gnubok_search_tools query with its top hits: what agents asked for, found
  // or not.
  'mcp.skill_not_found',
  'mcp.tool_searched',
  // Agent self-reported feedback: surfaces "this tool was missing", "this
  // description was wrong", etc. Reviewed weekly (matches the gnubok_feedback
  // reply copy).
  'agent.feedback',
  // Bank connection consent lifecycle: required audit trail per ASVS V16
  // and GDPR Art.30 (records of processing) for PSD2 consent decisions.
  'bank_connection.consent_granted',
  // Denied/failed consent attempts: the pending bank_connections row is
  // deleted on failure and console logs expire, so this durable trail is the
  // only way support can answer "which attempt, which error, whose side"
  // (issue #1716).
  'bank_connection.consent_denied',
  'bank_connection.finalize_failed',
  'bank_connection.account_selection_changed',
  'bank_connection.revoked',
  'bank_connection.superseded',
  // Every failed bank sync (cron, manual, agent): the server log line was
  // the only trace and it expires (feedback seq 340107).
  'bank_connection.sync_failed',
  // A räkenskapsår's K2/K3 framework changed (BFNAR 2012:4 punkt 3: a change
  // of accounting principle). The audit_log row holds the old and new value.
  'company.accounting_framework_changed',
]

/**
 * Event types persisted to the event_log table, which GET /api/events serves.
 *
 * Every event in the public webhook catalogue (lib/webhooks/public-events.ts)
 * is persisted, derived rather than hand-listed: the pull feed is how a
 * receiver that missed a webhook catches up, so an event that can be pushed
 * but not polled is lost for good once its delivery dies. A hand-copied list
 * drifted here before (11 of the 28 public events were never written).
 */
export const PERSISTED_EVENT_TYPES: ReadonlyArray<CoreEventType> = [
  ...new Set<CoreEventType>([...PUBLIC_WEBHOOK_EVENTS, ...INTERNAL_PERSISTED_EVENT_TYPES]),
]

// Excluded (with reasoning):
// - journal_entry.drafted: always followed by .committed

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Extract the primary entity ID from an event payload.
 */
function extractEntityId(payload: Record<string, unknown>): string | null {
  // Try common entity shapes in priority order
  const entityKeys = [
    'entry', 'invoice', 'transaction', 'customer', 'supplier', 'receipt',
    'supplierInvoice', 'creditNote', 'period', 'document', 'inboxItem', 'dimensionValue',
  ] as const

  for (const key of entityKeys) {
    const entity = payload[key]
    if (entity && typeof entity === 'object' && 'id' in entity) {
      const id = (entity as Record<string, unknown>).id
      if (typeof id === 'string') return id
    }
  }

  // Flat-string ID fields on events that don't carry a full entity object.
  // Bank connection events fall into this category: the connection lives in
  // an extension table, so we record its id directly. invoice.draft_deleted
  // carries only invoiceId because the row is already gone. The payroll,
  // reconciliation and question list events carry ids only.
  // event_log.entity_id is a uuid column, so a value that is not one is
  // skipped instead of failing the whole insert (the event matters more than
  // its index column).
  const flatIdKeys = [
    'connectionId', 'invoiceId', 'articleId', 'salaryRunId', 'agiId', 'signoffId', 'externalId', 'questionId',
  ] as const
  for (const key of flatIdKeys) {
    const id = payload[key]
    if (typeof id === 'string' && UUID_PATTERN.test(id)) return id
  }

  // For journal_entry.corrected: use the corrected entry's ID
  if ('corrected' in payload) {
    const corrected = payload.corrected
    if (corrected && typeof corrected === 'object' && 'id' in corrected) {
      const id = (corrected as Record<string, unknown>).id
      if (typeof id === 'string') return id
    }
  }

  // For journal_entry.reversed: use the reversal entry's ID
  if ('reversalEntry' in payload) {
    const reversalEntry = payload.reversalEntry
    if (reversalEntry && typeof reversalEntry === 'object' && 'id' in reversalEntry) {
      const id = (reversalEntry as Record<string, unknown>).id
      if (typeof id === 'string') return id
    }
  }

  return null
}

/**
 * Strip userId and companyId from payload (each stored in its own column) and
 * return clean data for the JSONB blob.
 */
function stripMetaFields(payload: Record<string, unknown>): Record<string, unknown> {
  const { userId: _userId, companyId: _companyId, ...data } = payload
  return data
}

/** Delay before the single retry of a network-class insert failure. */
const RETRY_DELAY_MS = 250

/**
 * Network-class failure: supabase-js (undici) surfaces a dead connection as
 * "TypeError: fetch failed", typically when the insert races Vercel function
 * suspension. Only this class is retried; Postgres errors (constraint
 * violations, RLS, bad columns) would fail identically on a retry.
 */
function isTransientNetworkError(message: string): boolean {
  return message.includes('fetch failed')
}

/**
 * Telemetry events (mcp.*, agent.*) are best-effort metrics: a lost row is
 * not actionable, so their final persistence failure logs at warn. Business
 * events (journal_entry.*, invoice.*, etc.) feed webhook delivery and stay
 * at error level.
 */
function isTelemetryEvent(eventType: string): boolean {
  return eventType.startsWith('mcp.') || eventType.startsWith('agent.')
}

/**
 * Persist a single event to the event_log table.
 * Retries once on network-class failures ("fetch failed") after a short delay.
 *
 * A deduped type (lib/events/dedupe-key.ts) is written with its natural key
 * and ON CONFLICT DO NOTHING: journal_entry.committed is already in event_log
 * when commit_journal_entry posted the entry (same transaction), so this
 * write only lands for an entry posted another way. The retry is safe for the
 * same reason.
 */
async function persistEvent(
  eventType: string,
  userId: string,
  companyId: string,
  entityId: string | null,
  data: Record<string, unknown>
): Promise<void> {
  const supabase = createServiceClientNoCookies()
  const dedupeKey = eventDedupeKey(eventType, entityId)
  const row = {
    user_id: userId,
    company_id: companyId,
    event_type: eventType,
    entity_id: entityId,
    data,
    ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
  }
  const write = () =>
    dedupeKey
      ? supabase.from('event_log').upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      : supabase.from('event_log').insert(row)

  let { error } = await write()

  if (error && isTransientNetworkError(error.message)) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    ;({ error } = await write())
  }

  if (error) {
    if (isTelemetryEvent(eventType)) {
      log.warn(`Failed to persist event ${eventType}:`, error.message)
    } else {
      log.error(`Failed to persist event ${eventType}:`, error.message)
    }
  }
}

/**
 * Register event log handlers on the event bus.
 * Persists events to the event_log table for external automation platforms.
 * Returns an array of unsubscribe functions. lib/init subscribes the same
 * handler through EVENT_CONSUMERS (lib/composition/event-consumers.ts).
 */
export function registerEventLogHandler(): (() => void)[] {
  return PERSISTED_EVENT_TYPES.map((eventType) =>
    eventBus.on(eventType, (payload) => writeEventLog(eventType, payload)),
  )
}

/** Persist one event of a PERSISTED_EVENT_TYPES type to event_log. Never throws. */
export async function writeEventLog(eventType: CoreEventType, payload: unknown): Promise<void> {
  try {
    const rawPayload = payload as Record<string, unknown>
    const userId = rawPayload.userId as string
    const companyId = rawPayload.companyId

    // All persisted event payloads mandate companyId in TypeScript; this guard
    // protects against any caller that bypasses the type system. Writing NULL
    // would make the row invisible to the company_id-scoped SELECT RLS policy.
    if (typeof companyId !== 'string' || companyId.length === 0) {
      log.error(`Event ${eventType} missing companyId; skipping persistence`)
      return
    }

    // transaction.synced carries an array: batch insert
    if (eventType === 'transaction.synced' && Array.isArray(rawPayload.transactions)) {
      const transactions = rawPayload.transactions as Array<Record<string, unknown>>
      if (transactions.length === 0) return

      const rows = transactions.map(tx => ({
        user_id: userId,
        company_id: companyId,
        event_type: eventType,
        entity_id: typeof tx.id === 'string' ? tx.id : null,
        data: { transaction: tx },
      }))

      const supabase = createServiceClientNoCookies()
      const { error } = await supabase.from('event_log').insert(rows)
      if (error) {
        log.error(`Failed to persist batch transaction.synced:`, error.message)
      }
      return
    }

    const entityId = extractEntityId(rawPayload)
    const data = stripMetaFields(rawPayload)
    await persistEvent(eventType, userId, companyId, entityId, data)
  } catch (err) {
    log.error(`Event log handler error for ${eventType}:`, err)
  }
}
