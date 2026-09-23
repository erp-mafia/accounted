import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * What has happened to a company's documents, as one list: arrivals, reads,
 * types set and changed, admissions, what the brain did, questions asked
 * over a channel, replacements. Read from the logs that already exist (the
 * audit trigger on document_attachments, the intake's processing history,
 * the Arkiv activities); nothing new is written for it.
 */
export type HistoryEventKind = 'ingested' | 'duplicate' | 'read' | 'typed' | 'retyped' | 'admitted' | 'discarded' | 'extracted' | 'derived' | 'asked' | 'replaced' | 'deleted' | 'unknown'
export type HistoryActorKind = 'user' | 'api_key' | 'agent' | 'system' | 'arkiv'

export interface HistoryEvent {
  id: string
  at: string
  kind: HistoryEventKind
  actor: { kind: HistoryActorKind; label: string | null }
  document: { id: string; file_name: string } | null
  detail: string | null
}

const PROCESSING_EVENTS = ['DocumentDuplicateSkipped', 'ChannelQuestionAsked', 'ChannelQuestionAnswered', 'TransactionDocumentReplaced'] as const

type AuditRow = { id: string; action: string; record_id: string | null; actor_type: string | null; actor_label: string | null; old_state: Record<string, unknown> | null; new_state: Record<string, unknown> | null; created_at: string }
type ProcessingRow = { event_id: string; event_type: string; aggregate_id: string | null; payload: Record<string, unknown> | null; actor: { type?: string; label?: string; id?: string } | null; occurred_at: string }
type ActivityRow = { id: string; document_id: string | null; kind: string; started_at: string; outcome: string | null }

function auditKind(row: AuditRow): HistoryEventKind | null {
  if (row.action === 'INSERT') return 'ingested'
  if (row.action === 'DELETE') return 'deleted'
  if (row.action !== 'UPDATE') return null
  const before = row.old_state ?? {}
  const after = row.new_state ?? {}
  if (before.admission_state !== after.admission_state) return after.admission_state === 'admitted' ? 'admitted' : after.admission_state === 'discarded' ? 'discarded' : null
  if (before.doc_type !== after.doc_type) return before.doc_type == null ? 'typed' : 'retyped'
  if (!before.pages_read_at && after.pages_read_at) return 'read'
  return null
}

function auditActor(row: AuditRow): HistoryEvent['actor'] {
  const kind: HistoryActorKind = row.actor_type === 'api_key' ? 'api_key' : row.actor_type === 'user' ? 'user' : 'system'
  return { kind, label: row.actor_label ?? null }
}

function processingKind(type: string): HistoryEventKind {
  if (type === 'DocumentDuplicateSkipped') return 'duplicate'
  if (type === 'ChannelQuestionAsked' || type === 'ChannelQuestionAnswered') return 'asked'
  if (type === 'TransactionDocumentReplaced') return 'replaced'
  return 'unknown'
}

function activityKind(kind: string): HistoryEventKind {
  if (kind === 'extract') return 'extracted'
  if (kind === 'derive') return 'derived'
  if (kind === 'ask') return 'asked'
  if (kind === 'read') return 'read'
  return 'unknown'
}

export async function listArchiveHistory(supabase: SupabaseClient, companyId: string, limit = 200): Promise<HistoryEvent[]> {
  // The audit trigger sees every write; the other two add what a write does not show.
  const [audit, processing, activities] = await Promise.all([
    supabase
      .from('audit_log')
      .select('id, action, record_id, actor_type, actor_label, old_state, new_state, created_at')
      .eq('company_id', companyId)
      .eq('table_name', 'document_attachments')
      .order('created_at', { ascending: false })
      .limit(limit * 4),
    supabase
      .from('processing_history')
      .select('event_id, event_type, aggregate_id, payload, actor, occurred_at')
      .eq('company_id', companyId)
      .in('event_type', [...PROCESSING_EVENTS])
      .order('occurred_at', { ascending: false })
      .limit(limit),
    supabase.from('activities').select('id, document_id, kind, started_at, outcome').eq('company_id', companyId).order('started_at', { ascending: false }).limit(limit),
  ])
  for (const r of [audit, processing, activities]) if (r.error) throw new Error(`history read failed: ${r.error.message}`)

  const events: HistoryEvent[] = []
  const documentIds = new Set<string>()
  for (const row of (audit.data ?? []) as AuditRow[]) {
    const kind = auditKind(row)
    if (!kind) continue
    if (row.record_id) documentIds.add(row.record_id)
    const after = row.new_state ?? {}
    const detail = kind === 'typed' || kind === 'retyped' ? (typeof after.doc_type === 'string' ? after.doc_type : null) : null
    events.push({ id: `audit:${row.id}`, at: row.created_at, kind, actor: auditActor(row), document: row.record_id ? { id: row.record_id, file_name: typeof after.file_name === 'string' ? after.file_name : '' } : null, detail })
  }
  for (const row of (processing.data ?? []) as ProcessingRow[]) {
    const docId = row.aggregate_id ?? (typeof row.payload?.document_id === 'string' ? row.payload.document_id : null)
    if (docId) documentIds.add(docId)
    const actorType = row.actor?.type
    events.push({
      id: `ph:${row.event_id}`,
      at: row.occurred_at,
      kind: processingKind(row.event_type),
      actor: { kind: actorType === 'user' ? 'user' : actorType === 'api_key' ? 'api_key' : 'system', label: row.actor?.label ?? row.actor?.id ?? null },
      document: docId ? { id: docId, file_name: '' } : null,
      detail: null,
    })
  }
  for (const row of (activities.data ?? []) as ActivityRow[]) {
    if (row.document_id) documentIds.add(row.document_id)
    events.push({ id: `act:${row.id}`, at: row.started_at, kind: activityKind(row.kind), actor: { kind: 'arkiv', label: null }, document: row.document_id ? { id: row.document_id, file_name: '' } : null, detail: row.outcome ?? null })
  }

  // File names: the audit row carries one, the others do not.
  const ids = [...documentIds]
  if (ids.length) {
    const { data, error } = await supabase.from('document_attachments').select('id, file_name').in('id', ids.slice(0, 1000))
    if (error) throw new Error(`history read failed: ${error.message}`)
    const names = new Map(((data ?? []) as Array<{ id: string; file_name: string }>).map((d) => [d.id, d.file_name]))
    for (const e of events) if (e.document && !e.document.file_name) e.document.file_name = names.get(e.document.id) ?? e.document.file_name
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return events.slice(0, limit)
}
