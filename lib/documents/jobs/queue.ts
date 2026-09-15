import type { SupabaseClient } from '@supabase/supabase-js'
import { arkivRollout, isArkivEnabled } from '@/lib/arkiv/flag'
import { classifyDocument, loadCompanyIdentity, type CompanyIdentity } from '@/lib/documents/classify/classify'
import { extractDocument } from '@/lib/documents/extract/store'
import { readAndStoreDocument, type ReadableDocumentRow } from '@/lib/documents/read/store'
import { createLogger } from '@/lib/logger'

const log = createLogger('documents/jobs')

/**
 * Arkiv phase 3: the document pipeline as a queue. An upload queues a read
 * job and returns; the worker cron claims due jobs (SKIP LOCKED, so
 * overlapping ticks never run a job twice) and runs read, classify and
 * extract, each step queueing the next. A failed step retries with backoff
 * until max_attempts and keeps its last error.
 */
export type JobKind = 'read' | 'classify' | 'extract'

export interface ClaimedJob {
  id: string
  company_id: string
  document_id: string
  kind: JobKind
  attempts: number
}

export interface RunSummary {
  claimed: number
  done: number
  failed: number
  /** Claimed but handed back untouched because the time budget ran out. */
  returned: number
}

/** Queue one step for a document. False when a queued or running job already covers it. */
export async function enqueueDocumentJob(supabase: SupabaseClient, companyId: string, documentId: string, kind: JobKind): Promise<boolean> {
  const { data, error } = await supabase.rpc('enqueue_document_job', { p_company_id: companyId, p_document_id: documentId, p_kind: kind })
  if (error) throw new Error(`enqueue ${kind} failed: ${error.message}`)
  return data === true
}

/** Queue extract jobs for admitted documents in the rollout that never had one. Returns how many were queued. */
export async function enqueueMissingExtractions(supabase: SupabaseClient, limit: number): Promise<number> {
  const rollout = arkivRollout()
  if (rollout !== 'all' && rollout.length === 0) return 0
  const { data, error } = await supabase.rpc('enqueue_missing_document_extractions', {
    p_company_ids: rollout === 'all' ? null : rollout,
    p_limit: limit,
  })
  if (error) throw new Error(`extraction backfill failed: ${error.message}`)
  return (data as number | null) ?? 0
}

export async function runDocumentJobs(
  supabase: SupabaseClient,
  opts: { limit: number; worker: string; budgetMs: number; now?: () => number },
): Promise<RunSummary> {
  const now = opts.now ?? Date.now
  const deadline = now() + opts.budgetMs
  const { data, error } = await supabase.rpc('claim_document_jobs', { p_batch_size: opts.limit, p_worker: opts.worker })
  if (error) throw new Error(`claim failed: ${error.message}`)
  const jobs = (data ?? []) as ClaimedJob[]
  const summary: RunSummary = { claimed: jobs.length, done: 0, failed: 0, returned: 0 }
  const identities = new Map<string, CompanyIdentity>()

  for (const job of jobs) {
    if (now() > deadline) {
      await settleJob(supabase, job, { status: 'queued', attempts: job.attempts - 1 })
      summary.returned++
      continue
    }
    try {
      const result = await runStep(supabase, job, identities)
      await settleJob(supabase, job, { status: 'done', result, last_error: null })
      summary.done++
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500)
      await settleJob(supabase, job, { status: 'failed', last_error: reason, run_after: new Date(now() + backoffMs(job.attempts)).toISOString() })
      summary.failed++
      log.warn('document job failed', { job: job.id, kind: job.kind, doc: job.document_id, attempt: job.attempts, reason })
    }
  }
  return summary
}

/** 2, 4, 8, 16, 32 minutes, capped at an hour. */
const backoffMs = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000

async function settleJob(supabase: SupabaseClient, job: ClaimedJob, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('document_jobs').update({ ...patch, locked_at: null, locked_by: null }).eq('id', job.id)
  if (error) log.error('document job update failed', { job: job.id, reason: error.message })
}

/** Run one step and queue the next. Returns a short outcome note; throws to fail the job and retry later. */
function runStep(supabase: SupabaseClient, job: ClaimedJob, identities: Map<string, CompanyIdentity>): Promise<string> {
  switch (job.kind) {
    case 'read':
      return runRead(supabase, job)
    case 'classify':
      return runClassify(supabase, job, identities)
    case 'extract':
      return runExtract(supabase, job, identities)
  }
}

async function runRead(supabase: SupabaseClient, job: ClaimedJob): Promise<string> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id, company_id, storage_path, mime_type')
    .eq('id', job.document_id)
    .maybeSingle()
  if (error) throw new Error(`document fetch failed: ${error.message}`)
  if (!data) return 'skipped: not_found'
  const out = await readAndStoreDocument(supabase, data as ReadableDocumentRow)
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return `skipped: ${out.reason}`
  if (isArkivEnabled(job.company_id)) await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'classify')
  return `read ${out.pages} pages (${out.reader})${out.partial ? `, partial: ${out.partial}` : ''}`
}

async function runClassify(supabase: SupabaseClient, job: ClaimedJob, identities: Map<string, CompanyIdentity>): Promise<string> {
  if (!isArkivEnabled(job.company_id)) return 'skipped: not_in_rollout'
  const out = await classifyDocument(supabase, job.document_id, await identityFor(supabase, job.company_id, identities))
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return skipNote(out.reason)
  if (out.admission === 'admitted') await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'extract')
  return `classified ${out.classification.doc_type} (${out.admission})`
}

async function runExtract(supabase: SupabaseClient, job: ClaimedJob, identities: Map<string, CompanyIdentity>): Promise<string> {
  if (!isArkivEnabled(job.company_id)) return 'skipped: not_in_rollout'
  const out = await extractDocument(supabase, job.document_id, await identityFor(supabase, job.company_id, identities))
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return skipNote(out.reason)
  return `extracted ${out.schemaType}${out.reviewFields.length ? `, review: ${out.reviewFields.join(', ')}` : ''}`
}

/** Outcome note for a skip. A model that is not configured yet is worth waiting for, so that skip fails the job and retries. */
function skipNote(reason: string): string {
  if (reason === 'ai_unconfigured') throw new Error('ai_unconfigured')
  return `skipped: ${reason}`
}

async function identityFor(supabase: SupabaseClient, companyId: string, cache: Map<string, CompanyIdentity>): Promise<CompanyIdentity> {
  const cached = cache.get(companyId)
  if (cached) return cached
  const identity = await loadCompanyIdentity(supabase, companyId)
  cache.set(companyId, identity)
  return identity
}
