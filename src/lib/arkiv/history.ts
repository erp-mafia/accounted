import type { SupabaseClient } from '@supabase/supabase-js'
import { STRUCTURED_MIME_TYPES } from '@/lib/documents/read/types'

/**
 * What has happened to a company's documents, as one list: arrivals, reads,
 * types set and changed, admissions, what the brain did, questions asked
 * over a channel, replacements. Read from the logs that already exist;
 * nothing new is written for it.
 *
 * Who did what comes from the log that knows: the audit trigger on
 * document_attachments records the uploader as the actor of every later
 * write to the row (actor_type falls back to 'user'), so a read by the
 * pipeline would show as a person. Reads are therefore always Arkiv's, and
 * a type set or changed is taken from document_classifications, whose
 * decided_by says whether the model or a person chose it. The structured
 * archives (bank responses, XML payloads) are files, never documents: they
 * are kept out here as the list keeps them out.
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
const STRUCTURED = new Set<string>(STRUCTURED_MIME_TYPES)

type AuditRow = { id: string; action: string; record_id: string | null; user_id: string | null; actor_type: string | null; actor_label: string | null; old_state: Record<string, unknown> | null; new_state: Record<string, unknown> | null; created_at: string }
type ProcessingRow = { event_id: string; event_type: string; aggregate_id: string | null; payload: Record<string, unknown> | null; actor: { type?: string; label?: string; id?: string } | null; occurred_at: string }
type ActivityRow = { id: string; document_id: string | null; kind: string; started_at: string }
type ClassificationRow = { id: string; document_id: string; doc_type: string | null; decided_by: string; created_at: string }

const personOrSystem = (row: AuditRow): HistoryEvent['actor'] =>
  row.actor_type === 'api_key' ? { kind: 'api_key', label: row.actor_label ?? null } : row.user_id ? { kind: 'user', label: row.actor_label ?? null } : { kind: 'system', label: null }

/** The audit rows that are events: arrived, removed, admitted or discarded, read. A type change is not one here (see document_classifications). */
function auditEvent(row: AuditRow): { kind: HistoryEventKind; actor: HistoryEvent['actor'] } | null {
  if (row.action === 'INSERT') return { kind: 'ingested', actor: personOrSystem(row) }
  if (row.action === 'DELETE') return { kind: 'deleted', actor: personOrSystem(row) }
  if (row.action !== 'UPDATE') return null
  const before = row.old_state ?? {}
  const after = row.new_state ?? {}
  if (before.admission_state !== after.admission_state) {
    const kind: HistoryEventKind | null = after.admission_state === 'admitted' ? 'admitted' : after.admission_state === 'discarded' ? 'discarded' : null
    if (!kind) return null
    // The classifier admits in the same write that sets the type; a person answers admission alone.
    return { kind, actor: before.doc_type !== after.doc_type ? { kind: 'arkiv', label: null } : personOrSystem(row) }
  }
  if (!before.pages_read_at && after.pages_read_at && !after.read_error) return { kind: 'read', actor: { kind: 'arkiv', label: null } }
  return null
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

const mimeOf = (row: AuditRow): string | null => {
  const m = row.new_state?.mime_type ?? row.old_state?.mime_type
  return typeof m === 'string' ? m : null
}

export async function listArchiveHistory(supabase: SupabaseClient, companyId: string, limit = 200): Promise<HistoryEvent[]> {
  const [audit, processing, activities, classifications] = await Promise.all([
    supabase
      .from('audit_log')
      .select('id, action, record_id, user_id, actor_type, actor_label, old_state, new_state, created_at')
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
    supabase.from('activities').select('id, document_id, kind, started_at').eq('company_id', companyId).order('started_at', { ascending: false }).limit(limit),
    supabase.from('document_classifications').select('id, document_id, doc_type, decided_by, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(limit),
  ])
  for (const r of [audit, processing, activities, classifications]) if (r.error) throw new Error(`history read failed: ${r.error.message}`)

  const events: HistoryEvent[] = []
  const documentIds = new Set<string>()
  for (const row of (audit.data ?? []) as AuditRow[]) {
    const mime = mimeOf(row)
    if (mime && STRUCTURED.has(mime)) continue
    const ev = auditEvent(row)
    if (!ev) continue
    if (row.record_id) documentIds.add(row.record_id)
    // A deleted row has no new state: its name is in the old one.
    const state = row.action === 'DELETE' ? (row.old_state ?? {}) : (row.new_state ?? {})
    const fileName = typeof state.file_name === 'string' ? state.file_name : ''
    // The trigger writes one DELETE row per stored version of the file; a person removed one document.
    if (ev.kind === 'deleted' && events.some((e) => e.kind === 'deleted' && e.document?.id === row.record_id && e.at.slice(0, 16) === row.created_at.slice(0, 16))) continue
    events.push({ id: `audit:${row.id}`, at: row.created_at, kind: ev.kind, actor: ev.actor, document: row.record_id ? { id: row.record_id, file_name: fileName } : null, detail: null })
  }
  // Oldest first per document: the first type is "typed", every later one "retyped".
  const typedBefore = new Set<string>()
  const classified = [...((classifications.data ?? []) as ClassificationRow[])].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  for (const row of classified) {
    documentIds.add(row.document_id)
    const kind: HistoryEventKind = typedBefore.has(row.document_id) ? 'retyped' : 'typed'
    typedBefore.add(row.document_id)
    events.push({
      id: `cls:${row.id}`,
      at: row.created_at,
      kind,
      actor: row.decided_by === 'human' ? { kind: 'user', label: null } : { kind: 'arkiv', label: null },
      document: { id: row.document_id, file_name: '' },
      detail: row.doc_type,
    })
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
    events.push({ id: `act:${row.id}`, at: row.started_at, kind: activityKind(row.kind), actor: { kind: 'arkiv', label: null }, document: row.document_id ? { id: row.document_id, file_name: '' } : null, detail: null })
  }

  // File names, and the mime type that says whether the row is a document at all.
  // A removed document is gone from the table: its name comes from the audit rows, and its
  // earlier events borrow it, so the list never shows a bare id.
  const ids = [...documentIds]
  const structuredDocs = new Set<string>()
  const names = new Map<string, string>()
  for (const e of events) if (e.document?.file_name && !names.has(e.document.id)) names.set(e.document.id, e.document.file_name)
  if (ids.length) {
    const { data, error } = await supabase.from('document_attachments').select('id, file_name, mime_type').in('id', ids.slice(0, 1000))
    if (error) throw new Error(`history read failed: ${error.message}`)
    for (const d of (data ?? []) as Array<{ id: string; file_name: string; mime_type: string | null }>) {
      names.set(d.id, d.file_name)
      if (d.mime_type && STRUCTURED.has(d.mime_type)) structuredDocs.add(d.id)
    }
  }
  for (const e of events) if (e.document && !e.document.file_name) e.document.file_name = names.get(e.document.id) ?? e.document.file_name

  return events
    .filter((e) => !e.document || !structuredDocs.has(e.document.id))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
}
