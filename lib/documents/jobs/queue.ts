import type { SupabaseClient } from '@supabase/supabase-js'
import { arkivRollout, isArkivEnabled } from '@/lib/arkiv/flag'
import { classifyDocument, loadCompanyIdentity, type CompanyIdentity } from '@/lib/documents/classify/classify'
import { extractDocument } from '@/lib/documents/extract/store'
import { agreementKindFor } from '@/lib/arkiv/agreements/derive'
import { deriveDocument } from '@/lib/arkiv/agreements/store'
import { hasFactPredicates } from '@/lib/arkiv/facts/predicates'
import { recordFactsForDocument } from '@/lib/arkiv/facts/store'
import { LANE_COLUMNS, readDocumentByPlan, type ReadableDocumentRow } from '@/lib/documents/read/store'
import { isActingType } from '@/lib/documents/read/lanes'
import { recordArkivUsage } from '@/lib/arkiv/usage'
import { createLogger } from '@/lib/logger'

const log = createLogger('documents/jobs')

/**
 * Arkiv phase 3: the document pipeline as a queue. An upload queues a read
 * job and returns; the worker cron claims due jobs (SKIP LOCKED, so
 * overlapping ticks never run a job twice) and runs read, classify, extract
 * and derive, each step queueing the next. A failed step retries with backoff
 * until max_attempts and keeps its last error.
 */
export type JobKind = 'read' | 'classify' | 'extract' | 'derive'

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

export async function runDocumentJobs(supabase: SupabaseClient, opts: { limit: number; worker: string; budgetMs: number; now?: () => number }): Promise<RunSummary> {
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
    const outcome = await runClaimed(supabase, job, identities, now)
    if ('error' in outcome) summary.failed++
    else summary.done++
  }
  return summary
}

/** One claimed job: run its step, settle it done or failed with backoff. */
async function runClaimed(
  supabase: SupabaseClient,
  job: ClaimedJob,
  identities: Map<string, CompanyIdentity>,
  now: () => number,
): Promise<{ kind: string; result: string } | { kind: string; error: string }> {
  try {
    const result = await runStep(supabase, job, identities)
    await settleJob(supabase, job, { status: 'done', result, last_error: null })
    return { kind: job.kind, result }
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    await settleJob(supabase, job, { status: 'failed', last_error: reason, run_after: new Date(now() + backoffMs(job.attempts)).toISOString() })
    log.warn('document job failed', { job: job.id, kind: job.kind, doc: job.document_id, attempt: job.attempts, reason })
    return { kind: job.kind, error: reason }
  }
}

/**
 * Runs the one due step of a single document now: the upload surface polls
 * this while a person watches, so a document lands in seconds instead of on
 * the next cron ticks. Null when the document has nothing due.
 */
export async function runDocumentJobFor(
  supabase: SupabaseClient,
  documentId: string,
  worker: string,
): Promise<{ kind: string; result: string } | { kind: string; error: string } | null> {
  const { data, error } = await supabase.rpc('claim_document_job_for', { p_document_id: documentId, p_worker: worker })
  if (error) throw new Error(`claim failed: ${error.message}`)
  const job = ((data ?? []) as ClaimedJob[])[0]
  if (!job) return null
  return runClaimed(supabase, job, new Map(), Date.now)
}

/** 2, 4, 8, 16, 32 minutes, capped at an hour. */
const backoffMs = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000

async function settleJob(supabase: SupabaseClient, job: ClaimedJob, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('document_jobs')
    .update({ ...patch, locked_at: null, locked_by: null })
    .eq('id', job.id)
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
    case 'derive':
      return runDerive(supabase, job)
  }
}

async function runRead(supabase: SupabaseClient, job: ClaimedJob): Promise<string> {
  const { data, error } = await supabase.from('document_attachments').select(`${LANE_COLUMNS}, admission_state`).eq('id', job.document_id).maybeSingle()
  if (error) throw new Error(`document fetch failed: ${error.message}`)
  if (!data) return 'skipped: not_found'
  const doc = data as ReadableDocumentRow & { admission_state: string | null }
  // A second pass finishes a document the lane capped at one page (an acting type): the extraction waited for it.
  const finishing = doc.read_error === 'partial:budget'
  const { plan, outcome: out } = await readDocumentByPlan(supabase, doc)
  if (!plan || !out) return 'skipped: lane_done'
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return `skipped: ${out.reason}`
  if (isArkivEnabled(job.company_id)) {
    if (!doc.doc_type) await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'classify')
    else if (finishing && doc.admission_state === 'admitted') await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'extract')
  }
  return `read ${out.pages} pages (${out.reader}, ${plan.lane})${out.partial ? `, partial: ${out.partial}` : ''}`
}

async function runClassify(supabase: SupabaseClient, job: ClaimedJob, identities: Map<string, CompanyIdentity>): Promise<string> {
  if (!isArkivEnabled(job.company_id)) return 'skipped: not_in_rollout'
  const out = await classifyDocument(supabase, job.document_id, await identityFor(supabase, job.company_id, identities))
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return skipNote(out.reason)
  await recordArkivUsage(supabase, job.company_id, 'documents', 1)
  if (out.admission === 'admitted') {
    // A loose history document read one page deep that turned out to be an acting type is read in full before it is extracted.
    const { data: row } = await supabase.from('document_attachments').select('read_error').eq('id', job.document_id).maybeSingle()
    const capped = (row as { read_error?: string | null } | null)?.read_error === 'partial:budget'
    if (capped && isActingType(out.classification.doc_type)) {
      await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'read')
      return `classified ${out.classification.doc_type} (${out.admission}), reading the rest`
    }
    await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'extract')
  }
  return `classified ${out.classification.doc_type} (${out.admission})`
}

async function runExtract(supabase: SupabaseClient, job: ClaimedJob, identities: Map<string, CompanyIdentity>): Promise<string> {
  if (!isArkivEnabled(job.company_id)) return 'skipped: not_in_rollout'
  const out = await extractDocument(supabase, job.document_id, await identityFor(supabase, job.company_id, identities))
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return skipNote(out.reason)
  await recordArkivUsage(supabase, job.company_id, 'extractions', 1)
  if (agreementKindFor(out.schemaType) || hasFactPredicates(out.schemaType)) await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'derive')
  return `extracted ${out.schemaType}${out.reviewFields.length ? `, review: ${out.reviewFields.join(', ')}` : ''}`
}

async function runDerive(supabase: SupabaseClient, job: ClaimedJob): Promise<string> {
  if (!isArkivEnabled(job.company_id)) return 'skipped: not_in_rollout'
  const out = await deriveDocument(supabase, job.document_id)
  if (out.status === 'error') throw new Error(out.reason)
  const facts = await recordFactsForDocument(supabase, job.document_id)
  if (facts.status === 'error') throw new Error(facts.reason)
  const factNote = facts.status === 'recorded' ? `${facts.facts} facts` : `facts skipped: ${facts.reason}`
  if (out.status === 'skipped') return `skipped: ${out.reason}; ${factNote}`
  return `derived ${out.obligations} obligations, ${out.deadlines} deadlines, ${factNote}${out.waitingOn.length ? `, waiting on ${out.waitingOn.join(', ')}` : ''}`
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
