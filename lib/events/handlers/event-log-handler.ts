import { eventBus } from '@/lib/events/bus'
import type { CoreEventType } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'

const log = createLogger('event-log')

/**
 * Event types persisted to the event_log table for external automation platforms.
 * Excludes noise events that are always followed by an actionable event.
 */
const PERSISTED_EVENT_TYPES: CoreEventType[] = [
  'journal_entry.committed',
  'journal_entry.reversed',
  'journal_entry.corrected',
  'document.uploaded',
  'document.accessed',
  'document.deleted',
  'invoice.created',
  'invoice.draft_deleted',
  'invoice.sent',
  'credit_note.created',
  'transaction.synced',
  'transaction.categorized',
  'transaction.reconciled',
  'period.locked',
  'period.year_closed',
  'customer.created',
  'supplier.created',
  'receipt.matched',
  'receipt.confirmed',
  'supplier_invoice.registered',
  'supplier_invoice.approved',
  'supplier_invoice.paid',
  'supplier_invoice.credited',
  'invoice.match_confirmed',
  'supplier_invoice.match_confirmed',
  'supplier_invoice.confirmed',
  // MCP telemetry: every tool invocation, tools/list call, and resources/read.
  // Lightweight metadata only. mcp.*/agent.* rows are retained 180 days by the
  // cleanup cron (error-rate trends need more than the 30-day delivery window).
  'mcp.tool_called',
  'mcp.tools_list_called',
  'mcp.resource_read',
  // Workflow lifecycle + next-hint follow-through (Phase 3A). Tells us where
  // agents stall, which skills actually drive completion, and whether the
  // next-field rollout is paying off.
  'mcp.workflow_started',
  'mcp.workflow_completed',
  'mcp.next_hint_followed',
  // Every successful gnubok_load_skill, all tiers: which atoms agents
  // actually load. Joined against mcp.tool_called error rates to measure
  // whether a loaded atom helps or hurts.
  'mcp.skill_loaded',
  // Agent self-reported feedback: surfaces "this tool was missing", "this
  // description was wrong", etc. Reviewed weekly (matches the gnubok_feedback
  // reply copy); triage → dev_docs/mcp_optimization_plan.md.
  'agent.feedback',
  // Bank connection consent lifecycle: required audit trail per ASVS V16
  // and GDPR Art.30 (records of processing) for PSD2 consent decisions.
  'bank_connection.consent_granted',
  'bank_connection.account_selection_changed',
  'bank_connection.revoked',
  'bank_connection.cash_account_mirror_failed',
]

// Excluded (with reasoning):
// - journal_entry.drafted: always followed by .committed
// - receipt.extracted: intermediate AI step; .matched/.confirmed are actionable
// - supplier_invoice.received: inbox receipt; .confirmed is actionable
// - supplier_invoice.extracted: intermediate AI step

/**
 * Extract the primary entity ID from an event payload.
 */
function extractEntityId(payload: Record<string, unknown>): string | null {
  // Try common entity shapes in priority order
  const entityKeys = [
    'entry', 'invoice', 'transaction', 'customer', 'supplier', 'receipt',
    'supplierInvoice', 'creditNote', 'period', 'document', 'inboxItem',
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
  // carries only invoiceId because the row is already gone.
  if (typeof payload.connectionId === 'string') {
    return payload.connectionId
  }
  if (typeof payload.invoiceId === 'string') {
    return payload.invoiceId
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
 */
async function persistEvent(
  eventType: string,
  userId: string,
  companyId: string,
  entityId: string | null,
  data: Record<string, unknown>
): Promise<void> {
  const supabase = createServiceClientNoCookies()
  const row = {
    user_id: userId,
    company_id: companyId,
    event_type: eventType,
    entity_id: entityId,
    data,
  }

  let { error } = await supabase.from('event_log').insert(row)

  if (error && isTransientNetworkError(error.message)) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    ;({ error } = await supabase.from('event_log').insert(row))
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
 * Returns an array of unsubscribe functions.
 */
export function registerEventLogHandler(): (() => void)[] {
  return PERSISTED_EVENT_TYPES.map((eventType) =>
    eventBus.on(eventType, async (payload) => {
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
    })
  )
}
