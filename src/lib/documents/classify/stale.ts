import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { createLogger } from '@/lib/logger'
import { CLASSIFY_RULES, isStaleVerdict } from './rules'

const log = createLogger('documents/classify/stale')

export interface StaleRequeueSummary {
  /** Stale verdicts the query returned before the guards. */
  candidates: number
  /** Classify jobs queued this run. */
  queued: number
  /** Left out: a classify job already queued, running or failed, or the document has no pages to read. */
  skipped: number
}

/**
 * Queues a classify job for model verdicts the current rules might change
 * (CLASSIFY_RULES), at most `limit` per call so the spend per run is known
 * (one cheap model call per document). A document whose classify job is
 * queued, running or failed is left alone: the failed one until someone
 * looks at it, so a document the model cannot type never costs a call every
 * run. A document with no pages is left alone too: there is nothing to
 * re-read, and the verdict would stay stale forever.
 */
export async function requeueStaleVerdicts(supabase: SupabaseClient, limit: number): Promise<StaleRequeueSummary> {
  const summary: StaleRequeueSummary = { candidates: 0, queued: 0, skipped: 0 }
  if (limit <= 0) return summary
  // One query per rule change, each with its own cut-off, oldest verdicts first: the ones furthest behind the
  // rules go first, and a change whose verdicts are all current never hides another change's stale ones.
  type Verdict = { document_id: string; company_id: string; doc_type: string; rules_version: string | null; created_at: string }
  const rows: Verdict[] = []
  for (const change of CLASSIFY_RULES.changed) {
    const { data, error } = await supabase
      .from('document_classifications')
      .select('document_id, company_id, doc_type, rules_version, created_at')
      .eq('is_current', true)
      .eq('decided_by', 'model')
      .in('doc_type', [...change.types])
      .or(`and(rules_version.is.null,created_at.lt.${change.since}),rules_version.neq.${CLASSIFY_RULES.version}`)
      .order('created_at', { ascending: true })
      .limit(limit * 2)
    if (error) throw new Error(`stale verdicts fetch failed: ${error.message}`)
    for (const r of (data ?? []) as Verdict[]) if (isStaleVerdict(r)) rows.push(r)
  }
  summary.candidates = rows.length
  if (rows.length === 0) return summary

  const ids = rows.map((r) => r.document_id)
  const [jobs, docs] = await Promise.all([
    supabase.from('document_jobs').select('document_id, status').in('document_id', ids).eq('kind', 'classify'),
    supabase.from('document_attachments').select('id, pages_read_at, admission_state').in('id', ids),
  ])
  if (jobs.error) throw new Error(`stale verdicts jobs fetch failed: ${jobs.error.message}`)
  if (docs.error) throw new Error(`stale verdicts documents fetch failed: ${docs.error.message}`)
  const busy = new Set(((jobs.data ?? []) as Array<{ document_id: string; status: string }>).filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'failed').map((j) => j.document_id))
  const readable = new Set(((docs.data ?? []) as Array<{ id: string; pages_read_at: string | null; admission_state: string }>).filter((d) => d.pages_read_at && (d.admission_state === 'admitted' || d.admission_state === 'held')).map((d) => d.id))

  for (const row of rows) {
    if (summary.queued >= limit) break
    if (busy.has(row.document_id) || !readable.has(row.document_id)) {
      summary.skipped++
      continue
    }
    try {
      if (await enqueueDocumentJob(supabase, row.company_id, row.document_id, 'classify')) summary.queued++
      else summary.skipped++
    } catch (err) {
      summary.skipped++
      log.warn('stale verdict not queued', { doc: row.document_id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return summary
}
