import type { SupabaseClient } from '@supabase/supabase-js'
import { arkivBrainRollout, isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { classifyDocument, loadCompanyIdentity, SCHEMA_MISMATCH, SCHEMA_MISS_RESULT, type CompanyIdentity } from '@/lib/documents/classify/classify'
import { extractDocument } from '@/lib/documents/extract/store'
import { agreementKindFor } from '@/lib/arkiv/agreements/derive'
import { deriveDocument } from '@/lib/arkiv/agreements/store'
import { hasFactPredicates } from '@/lib/arkiv/facts/predicates'
import { recordFactsForDocument } from '@/lib/arkiv/facts/store'
import { readDocumentByPlan, type ReadableDocumentRow } from '@/lib/documents/read/store'
import { PROVIDER_UNAVAILABLE, READ_GAVE_UP, READER_UNAVAILABLE, outageBackoffMinutes } from '@/lib/documents/read/types'
import { isRunDeadlineCut } from '@/lib/ai/call-limit'
import { jobHasAttemptsLeft } from './hold'
import { isActingType, isBooked } from '@/lib/documents/read/lanes'
import { HEIC_MIME_TYPES } from '@/lib/documents/read/image'
import { ensurePreview } from '@/lib/documents/preview'
import { recordArkivUsage } from '@/lib/arkiv/usage'
import { isPeriodLockRefusal } from '@/lib/documents/locked-period'
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
}

/** Queue one step for a document. False when a queued or running job already covers it. */
export async function enqueueDocumentJob(supabase: SupabaseClient, companyId: string, documentId: string, kind: JobKind): Promise<boolean> {
  const { data, error } = await supabase.rpc('enqueue_document_job', { p_company_id: companyId, p_document_id: documentId, p_kind: kind })
  if (error) throw new Error(`enqueue ${kind} failed: ${error.message}`)
  return data === true
}

/** Queue extract jobs for admitted documents of the brain rollout that never had one. Returns how many were queued. */
export async function enqueueMissingExtractions(supabase: SupabaseClient, limit: number): Promise<number> {
  const rollout = arkivBrainRollout()
  if (rollout !== 'all' && rollout.length === 0) return 0
  const { data, error } = await supabase.rpc('enqueue_missing_document_extractions', {
    p_company_ids: rollout === 'all' ? null : rollout,
    p_limit: limit,
  })
  if (error) throw new Error(`extraction backfill failed: ${error.message}`)
  return (data as number | null) ?? 0
}

/**
 * Claims due jobs one at a time and runs each until none is due, starting
 * none at or after `deadlineAt` (epoch ms): the time is the run's only limit,
 * not a count. A job is claimed only when it is about to run: the batch used
 * to be claimed up front, so a run that was killed left the jobs it never
 * started marked running, each with an attempt spent, for the ten minutes
 * before another worker may take them over (the worker was seen at 242 s of
 * its 300 in the 30 days to 2026-11-12). Jobs not reached stay queued,
 * untouched, for the next tick a minute later. Which company's job comes next
 * is the claim's to decide (claim_document_jobs draws a company per job).
 */
export async function runDocumentJobs(supabase: SupabaseClient, opts: { worker: string; deadlineAt: number; now?: () => number }): Promise<RunSummary> {
  const now = opts.now ?? Date.now
  await failAbandonedJobs(supabase)
  const summary: RunSummary = { claimed: 0, done: 0, failed: 0 }
  const identities = new Map<string, CompanyIdentity>()

  while (now() < opts.deadlineAt) {
    const { data, error } = await supabase.rpc('claim_document_jobs', { p_batch_size: 1, p_worker: opts.worker })
    if (error) throw new Error(`claim failed: ${error.message}`)
    const job = ((data ?? []) as ClaimedJob[])[0]
    if (!job) break
    summary.claimed++
    const outcome = await runClaimed(supabase, job, identities, now)
    if ('error' in outcome) summary.failed++
    else summary.done++
  }
  return summary
}

/**
 * A worker that died during a job's last attempt never reaches the catch that
 * reports giving up, and no claim takes the job over, so it stayed 'running'
 * and its document unread (#115). The database fails such jobs; this reports
 * them. A failed sweep never stops the run: the next tick sweeps again.
 */
async function failAbandonedJobs(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase.rpc('fail_abandoned_document_jobs')
  if (error) {
    log.error('abandoned document job sweep failed', { reason: error.message })
    return
  }
  const jobs = (data ?? []) as ClaimedJob[]
  if (jobs.length > 0) {
    log.error('document jobs abandoned on their last attempt', {
      count: jobs.length,
      jobs: jobs.map(job => job.id),
      companies: [...new Set(jobs.map(job => job.company_id))],
    })
  }
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
    // The period-lock trigger on document_attachments (migration 017) refuses
    // every write to a document on an entry in a locked or closed period,
    // Arkiv's type and read stamps included. Retrying buys nothing and five
    // attempts with backoff ate the worker's minute (prod 2026-09-24), so the
    // job is settled as skipped; the document stays untyped until the lock
    // changes.
    if (isPeriodLockRefusal(reason)) {
      await settleJob(supabase, job, { status: 'done', result: 'skipped: period_locked', last_error: reason })
      return { kind: job.kind, result: 'skipped: period_locked' }
    }
    const fields = { job: job.id, kind: job.kind, doc: job.document_id, company: job.company_id, attempt: job.attempts, reason }
    // The same prompt gets the same answer: four more attempts only spend calls (seen 2026-11-09). Settled at once,
    // and reported once, since the document stays untyped until it is read again or a person types it.
    if (job.kind === 'classify' && reason.startsWith(SCHEMA_MISMATCH)) {
      await settleJob(supabase, job, { status: 'done', result: SCHEMA_MISS_RESULT, last_error: reason })
      log.error('document classification did not match schema, left for a person', fields)
      return { kind: job.kind, result: SCHEMA_MISS_RESULT }
    }
    // The reader gave the document up: five readings without an answer, counted on the document across the queue
    // and the backfill (lib/documents/read/store.ts). The job ends with it, out of attempts, so no claim takes it
    // again and the upload surface shows the read as failed. The reader reported it; this does not report it twice.
    if (job.kind === 'read' && reason.startsWith(READ_GAVE_UP)) {
      await settleJob(supabase, job, { status: 'failed', attempts: Math.max(job.attempts, MAX_ATTEMPTS), last_error: reason })
      log.warn('document job ended: the reader gave the document up', fields)
      return { kind: job.kind, error: reason }
    }
    // A call cut by the run's own stop is not the provider being down: the step did not fit in what was left of
    // the run (a job claimed late, a long scan). It is tried again on the short schedule, where the next run gives
    // it the whole run, instead of waiting half an hour for an outage that is not there. The attempt stays spent:
    // a step that never fits must run out of attempts, not come back every minute for good.
    const waitOut = waitsOutOutage(reason)
    await settleJob(supabase, job, { status: 'failed', last_error: reason, run_after: new Date(now() + backoffMs(job.attempts, waitOut)).toISOString() })
    // The last attempt leaves the document unread or untyped for good: that reaches error tracking, a retry does not.
    if (job.attempts >= MAX_ATTEMPTS) log.error('document job gave up', fields)
    else log.warn('document job failed', fields)
    return { kind: job.kind, error: reason }
  }
}

/**
 * Runs the one due step of a single document now: the upload surface polls
 * this while a person watches, so a document lands in seconds instead of on
 * the next cron ticks. Null when the document has nothing due, or when its
 * step is the worker's to run (leftToWorker).
 */
export async function runDocumentJobFor(
  supabase: SupabaseClient,
  documentId: string,
  worker: string,
  now: () => number = Date.now,
): Promise<{ kind: string; result: string } | { kind: string; error: string } | null> {
  const { data: open, error: openError } = await supabase.from('document_jobs').select('status, attempts, max_attempts, last_error, run_after').eq('document_id', documentId).neq('status', 'done')
  if (openError) throw new Error(`jobs fetch failed: ${openError.message}`)
  const at = now()
  if (((open ?? []) as OpenStep[]).some((step) => leftToWorker(step, at))) return null
  const { data, error } = await supabase.rpc('claim_document_job_for', { p_document_id: documentId, p_worker: worker })
  if (error) throw new Error(`claim failed: ${error.message}`)
  const job = ((data ?? []) as ClaimedJob[])[0]
  if (!job) return null
  return runClaimed(supabase, job, new Map(), now)
}

interface OpenStep {
  status: string
  attempts: number
  max_attempts: number
  last_error: string | null
  run_after: string
}

/**
 * A step runDocumentJobFor leaves to the worker cron, which claims a step
 * only once its run_after is due, where claim_document_job_for takes a failed
 * step at once, backoff or not. Only a step the queue will still run: one out
 * of attempts is never claimed again, and must not keep the document's other
 * steps from running.
 *
 * - Cut by its run's deadline, due or not: the route that calls this has a
 *   minute, the worker five. Without this every poll of a person watching a
 *   long scan would start the read again, be cut again and spend an attempt,
 *   until none were left and a document the worker could have read was given
 *   up on.
 * - Failed on the provider, while its wait is still ahead: each poll (every
 *   1.5 s) asked the provider again and spent an attempt, so a one-minute
 *   outage used up all five, the job gave up and the upload showed the read
 *   as failed (#210). Left alone it spends one attempt a wait, as in the
 *   worker, and shows as on its way; once the wait is over a poll claims it,
 *   as before.
 */
function leftToWorker(step: OpenStep, now: number): boolean {
  if (!jobHasAttemptsLeft(step)) return false
  if (isRunDeadlineCut(step.last_error)) return true
  return step.status === 'failed' && waitsOutOutage(step.last_error ?? '') && Date.parse(step.run_after) > now
}

/** document_jobs.max_attempts (the column default; nothing sets another). */
const MAX_ATTEMPTS = 5

/**
 * 2, 4, 8, 16 minutes, capped at an hour. A provider outage waits 30, 60, 120
 * and 240 minutes instead (outageBackoffMinutes, the schedule a document's
 * unanswered readings share), so the five attempts span about 7.5 hours.
 */
const backoffMs = (attempts: number, providerOutage = false) =>
  (providerOutage ? outageBackoffMinutes(attempts) : Math.min(60, 2 ** attempts)) * 60_000

/** The step failed on the reader or the model provider, not on the document. */
const isProviderOutage = (reason: string) => reason.startsWith(READER_UNAVAILABLE) || reason.startsWith(PROVIDER_UNAVAILABLE)

/**
 * The step waits out a provider outage: it failed on the reader or the
 * provider, and not because its run's own stop cut it. Such a step gets the
 * outage's backoff, and runDocumentJobFor leaves it alone until that is over.
 */
const waitsOutOutage = (reason: string) => isProviderOutage(reason) && !isRunDeadlineCut(reason)

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
  const { data, error } = await supabase.from('document_attachments').select('id, company_id, storage_path, mime_type, created_at, journal_entry_id, journal_entry_line_id, doc_type, pages_read_at, read_error, admission_state').eq('id', job.document_id).maybeSingle()
  if (error) throw new Error(`document fetch failed: ${error.message}`)
  if (!data) return 'skipped: not_found'
  const doc = data as ReadableDocumentRow & { admission_state: string | null }
  // A second pass finishes a document the lane capped at one page (an acting type): the extraction waited for it.
  const finishing = doc.read_error === 'partial:budget'
  const { plan, outcome: out } = await readDocumentByPlan(supabase, doc)
  // A new iPhone photo gets its viewer preview now, so the first person to open it does not wait for the HEIC decode.
  if (plan?.lane === 'live' && doc.mime_type && (HEIC_MIME_TYPES as readonly string[]).includes(doc.mime_type)) {
    await ensurePreview(supabase, { id: doc.id, company_id: job.company_id, mime: doc.mime_type, storage_path: doc.storage_path })
  }
  if (!plan || !out) return 'skipped: lane_done'
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return `skipped: ${out.reason}`
  // A booked document is typed when someone opens it (goal: agents answer correctly when asked).
  if (!doc.doc_type && !isBooked(doc)) await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'classify')
  else if (finishing && doc.admission_state === 'admitted' && isArkivBrainEnabled(job.company_id)) await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'extract')
  return `read ${out.pages} pages (${out.reader}, ${plan.lane})${out.partial ? `, partial: ${out.partial}` : ''}`
}

async function runClassify(supabase: SupabaseClient, job: ClaimedJob, identities: Map<string, CompanyIdentity>): Promise<string> {
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
    // The brain reads the record out of the document; the shelf stops at the type.
    if (isArkivBrainEnabled(job.company_id)) await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'extract')
  }
  return `classified ${out.classification.doc_type} (${out.admission})`
}

async function runExtract(supabase: SupabaseClient, job: ClaimedJob, identities: Map<string, CompanyIdentity>): Promise<string> {
  if (!isArkivBrainEnabled(job.company_id)) return 'skipped: not_in_rollout'
  const out = await extractDocument(supabase, job.document_id, await identityFor(supabase, job.company_id, identities))
  if (out.status === 'error') throw new Error(out.reason)
  if (out.status === 'skipped') return skipNote(out.reason)
  await recordArkivUsage(supabase, job.company_id, 'extractions', 1)
  if (agreementKindFor(out.schemaType) || hasFactPredicates(out.schemaType)) await enqueueDocumentJob(supabase, job.company_id, job.document_id, 'derive')
  return `extracted ${out.schemaType}${out.reviewFields.length ? `, review: ${out.reviewFields.join(', ')}` : ''}`
}

async function runDerive(supabase: SupabaseClient, job: ClaimedJob): Promise<string> {
  if (!isArkivBrainEnabled(job.company_id)) return 'skipped: not_in_rollout'
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
