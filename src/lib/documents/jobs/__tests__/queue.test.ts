import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))

vi.mock('@/lib/documents/read/store', () => ({ readDocumentByPlan: vi.fn() }))
vi.mock('@/lib/documents/classify/classify', () => ({
  classifyDocument: vi.fn(),
  loadCompanyIdentity: vi.fn(async () => ({ name: 'Exempelbolaget AB', orgNumber: null })),
  SCHEMA_MISMATCH: 'classification did not match schema',
  SCHEMA_MISS_RESULT: 'skipped: schema_mismatch',
}))
vi.mock('@/lib/documents/extract/store', () => ({ extractDocument: vi.fn() }))
vi.mock('@/lib/arkiv/agreements/store', () => ({ deriveDocument: vi.fn() }))
vi.mock('@/lib/arkiv/facts/store', () => ({ recordFactsForDocument: vi.fn() }))
vi.mock('@/lib/arkiv/usage', () => ({ recordArkivUsage: vi.fn(async () => undefined) }))

import { enqueueDocumentJob, enqueueMissingExtractions, runDocumentJobs, type ClaimedJob } from '../queue'
import { readDocumentByPlan } from '@/lib/documents/read/store'
import { classifyDocument } from '@/lib/documents/classify/classify'
import { extractDocument } from '@/lib/documents/extract/store'
import { deriveDocument } from '@/lib/arkiv/agreements/store'
import { recordFactsForDocument } from '@/lib/arkiv/facts/store'
import { recordArkivUsage } from '@/lib/arkiv/usage'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc
const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({ id: 'job-1', company_id: 'co-1', document_id: 'doc-1', kind: 'read', attempts: 1, ...over })
const DOCUMENT = { id: 'doc-1', company_id: 'co-1', storage_path: 'documents/co-1/a.pdf', mime_type: 'application/pdf' }
const lastJobUpdate = () => findCalls('document_jobs', 'update').at(-1)?.[0]
const run = (over: Partial<Parameters<typeof runDocumentJobs>[1]> = {}) => runDocumentJobs(supabase, { limit: 8, worker: 'test', deadlineAt: Number.MAX_SAFE_INTEGER, ...over })
/**
 * A run first fails abandoned jobs (none here), then claims these one at a
 * time, each when the one before it is settled: the claim RPC hands out the
 * next due job, the way the database does, without taking a place in the
 * queue of answers the steps read.
 */
let due: ClaimedJob[] | null = null
const claim = (...jobs: ClaimedJob[]) => {
  enqueue({ data: [] })
  due = jobs
}
const queuedRpc = rpc.getMockImplementation()!

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  due = null
  rpc.mockImplementation((name: string, args: { p_batch_size?: number }) =>
    name === 'claim_document_jobs' && due ? Promise.resolve({ data: due.splice(0, args.p_batch_size), error: null }) : queuedRpc(name, args),
  )
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'co-1'
})

afterEach(() => {
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
})

describe('enqueueDocumentJob', () => {
  it('queues through the RPC and says whether a job was queued', async () => {
    enqueue({ data: true })
    await expect(enqueueDocumentJob(supabase, 'co-1', 'doc-1', 'extract')).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'extract' })
    enqueue({ data: false })
    await expect(enqueueDocumentJob(supabase, 'co-1', 'doc-1', 'extract')).resolves.toBe(false)
  })

  it('throws when the RPC fails', async () => {
    enqueue({ error: { message: 'no function' } })
    await expect(enqueueDocumentJob(supabase, 'co-1', 'doc-1', 'read')).rejects.toThrow('enqueue read failed: no function')
  })
})

describe('enqueueMissingExtractions', () => {
  it('does nothing when nobody is in the rollout', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    await expect(enqueueMissingExtractions(supabase, 20)).resolves.toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('passes the listed companies, or null for everyone', async () => {
    enqueue({ data: 3 })
    await expect(enqueueMissingExtractions(supabase, 20)).resolves.toBe(3)
    expect(rpc).toHaveBeenLastCalledWith('enqueue_missing_document_extractions', { p_company_ids: ['co-1'], p_limit: 20 })
    process.env.ARKIV_BRAIN_COMPANY_IDS = '*'
    enqueue({ data: 0 })
    await enqueueMissingExtractions(supabase, 20)
    expect(rpc).toHaveBeenLastCalledWith('enqueue_missing_document_extractions', { p_company_ids: null, p_limit: 20 })
  })
})

describe('runDocumentJobs', () => {
  it('reads a document, queues its classification and records the outcome', async () => {
    claim(job())
    enqueue({ data: DOCUMENT })
    mocked(readDocumentByPlan).mockResolvedValue({ plan: { lane: 'live', allowModel: true, maxModelPages: null }, outcome: { status: 'read', pages: 3, reader: 'pdf_text' } })
    enqueue({ data: true })
    enqueue({})

    await expect(run()).resolves.toEqual({ claimed: 1, done: 1, failed: 0 })
    // One job a claim: a job is marked running only when it is about to run.
    expect(rpc).toHaveBeenCalledWith('claim_document_jobs', { p_batch_size: 1, p_worker: 'test' })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'classify' })
    expect(lastJobUpdate()).toEqual({ status: 'done', result: 'read 3 pages (pdf_text, live)', last_error: null, locked_at: null, locked_by: null })
    // The meter for pages lives in the store; the runner counts nothing for a read.
    expect(recordArkivUsage).not.toHaveBeenCalled()
  })

  it('queues the extraction after the second read pass of a capped acting document, and stops when the lane is done', async () => {
    claim(job())
    enqueue({ data: { ...DOCUMENT, doc_type: 'agreement.loan', read_error: 'partial:budget', admission_state: 'admitted' } })
    mocked(readDocumentByPlan).mockResolvedValueOnce({ plan: { lane: 'history_loose', allowModel: true, maxModelPages: null }, outcome: { status: 'read', pages: 6, reader: 'claude_vision' } })
    enqueue({ data: true })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ done: 1 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'extract' })
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'read 6 pages (claude_vision, history_loose)' })

    reset()
    claim(job())
    enqueue({ data: { ...DOCUMENT, doc_type: 'receipt', read_error: 'partial:budget', admission_state: 'admitted' } })
    mocked(readDocumentByPlan).mockResolvedValueOnce({ plan: null, outcome: null })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ done: 1 })
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'skipped: lane_done' })
  })

  it('reads and classifies for every company, but extracts only in the brain rollout', async () => {
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'someone-else'
    claim(job(), job({ id: 'job-2', kind: 'extract' }))
    enqueue({ data: DOCUMENT })
    mocked(readDocumentByPlan).mockResolvedValue({ plan: { lane: 'live', allowModel: true, maxModelPages: null }, outcome: { status: 'read', pages: 1, reader: 'pdf_text' } })
    enqueue({ data: true })
    enqueue({})
    enqueue({})

    await expect(run()).resolves.toMatchObject({ done: 2 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'classify' })
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'skipped: not_in_rollout' })
  })

  it('queues extraction for an admitted document and fails a broken extraction with backoff', async () => {
    claim(job({ kind: 'classify' }), job({ id: 'job-2', kind: 'extract', attempts: 3 }))
    mocked(classifyDocument).mockResolvedValue({ status: 'classified', admission: 'admitted', classification: { doc_type: 'agreement.loan' } })
    enqueue({ data: { read_error: null } })
    enqueue({ data: true })
    enqueue({})
    mocked(extractDocument).mockResolvedValue({ status: 'error', reason: 'model timeout' })
    enqueue({})
    const t0 = Date.parse('2026-09-15T08:00:00Z')

    await expect(run({ now: () => t0 })).resolves.toEqual({ claimed: 2, done: 1, failed: 1 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'extract' })
    // A classified document counts once; a failed extraction counts nothing.
    expect(recordArkivUsage).toHaveBeenCalledTimes(1)
    expect(recordArkivUsage).toHaveBeenCalledWith(supabase, 'co-1', 'documents', 1)
    expect(lastJobUpdate()).toEqual({ status: 'failed', last_error: 'model timeout', run_after: new Date(t0 + 8 * 60_000).toISOString(), locked_at: null, locked_by: null })
  })

  it('settles a job the period-lock trigger refuses as skipped instead of retrying it five times', async () => {
    claim(job({ kind: 'classify' }))
    mocked(classifyDocument).mockResolvedValue({ status: 'error', reason: 'document update failed: Cannot attach documents to entries in a locked/closed fiscal period' })
    enqueue({})
    await expect(run()).resolves.toEqual({ claimed: 1, done: 1, failed: 0 })
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'skipped: period_locked' })
    expect(recordArkivUsage).not.toHaveBeenCalled()
  })

  it('settles a classification that did not match the schema on its first attempt instead of asking the same prompt five times', async () => {
    // Prod 2026-11-09: each such job spent five model calls and gave up with the document still untyped.
    const reason = 'classification did not match schema: confidence Too big: expected number to be <=1'
    claim(job({ kind: 'classify', attempts: 1 }))
    mocked(classifyDocument).mockResolvedValue({ status: 'error', reason })
    enqueue({})
    await expect(run()).resolves.toEqual({ claimed: 1, done: 1, failed: 0 })
    expect(classifyDocument).toHaveBeenCalledTimes(1)
    // Done, so no claim takes it again; no run_after, and the validation message kept for whoever looks.
    expect(lastJobUpdate()).toEqual({ status: 'done', result: 'skipped: schema_mismatch', last_error: reason, locked_at: null, locked_by: null })
    expect(recordArkivUsage).not.toHaveBeenCalled()
    // Reported once, on the attempt that settles it, not as a retry warning.
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith('document classification did not match schema, left for a person', expect.objectContaining({ job: 'job-1', doc: 'doc-1', attempt: 1, reason }))
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('keeps retrying any other classify failure with backoff', async () => {
    claim(job({ kind: 'classify', attempts: 1 }))
    mocked(classifyDocument).mockResolvedValue({ status: 'error', reason: 'insert failed: deadlock detected' })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ failed: 1 })
    expect(lastJobUpdate()).toMatchObject({ status: 'failed', last_error: 'insert failed: deadlock detected' })
  })

  it('reads the rest of a capped loose-history document before extracting it when it is an acting type', async () => {
    claim(job({ kind: 'classify' }))
    mocked(classifyDocument).mockResolvedValue({ status: 'classified', admission: 'admitted', classification: { doc_type: 'agreement.loan' } })
    enqueue({ data: { read_error: 'partial:budget' } })
    enqueue({ data: true })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ done: 1 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'read' })
    expect(rpc).not.toHaveBeenCalledWith('enqueue_document_job', expect.objectContaining({ p_kind: 'extract' }))
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'classified agreement.loan (admitted), reading the rest' })
  })

  it('waits out a provider outage with a long backoff instead of spending the attempts in half an hour', async () => {
    const t0 = Date.parse('2026-10-26T08:00:00Z')
    for (const [attempts, minutes] of [[1, 30], [2, 60], [3, 120], [4, 240]] as const) {
      reset()
      claim(job({ kind: 'classify', attempts }))
      mocked(classifyDocument).mockResolvedValue({ status: 'error', reason: 'provider_unavailable: 503 Bedrock is unable to process your request.' })
      enqueue({})
      await expect(run({ now: () => t0 })).resolves.toMatchObject({ failed: 1 })
      expect(lastJobUpdate()).toMatchObject({ status: 'failed', run_after: new Date(t0 + minutes * 60_000).toISOString() })
    }
  })

  it('treats a missing reader like a provider outage', async () => {
    claim(job({ kind: 'read', attempts: 2 }))
    enqueue({ data: DOCUMENT })
    mocked(readDocumentByPlan).mockResolvedValue({ plan: { lane: 'live', allowModel: true, maxModelPages: null }, outcome: { status: 'error', reason: 'reader_unavailable: 503 Bedrock is unable to process your request.' } })
    enqueue({})
    const t0 = Date.parse('2026-10-26T08:00:00Z')
    await expect(run({ now: () => t0 })).resolves.toMatchObject({ failed: 1 })
    expect(lastJobUpdate()).toMatchObject({ status: 'failed', run_after: new Date(t0 + 60 * 60_000).toISOString() })
  })

  it('retries a step the run\'s own stop cut on the short schedule: the provider is not down, the step did not fit', async () => {
    const t0 = Date.parse('2026-11-12T08:00:00Z')
    const cut = "reader_unavailable: Request timed out: the run's time was up 95 s into the model call"
    claim(job({ kind: 'read', attempts: 1 }))
    enqueue({ data: DOCUMENT })
    mocked(readDocumentByPlan).mockResolvedValue({ plan: { lane: 'live', allowModel: true, maxModelPages: null }, outcome: { status: 'error', reason: cut } })
    enqueue({})
    await expect(run({ now: () => t0 })).resolves.toMatchObject({ failed: 1 })
    // Two minutes, not the outage's thirty: the next run gives it the whole run. The attempt stays spent.
    expect(lastJobUpdate()).toEqual({ status: 'failed', last_error: cut, run_after: new Date(t0 + 2 * 60_000).toISOString(), locked_at: null, locked_by: null })

    // The call's own limit running out is the provider not answering: the outage schedule, as before.
    reset()
    claim(job({ kind: 'read', attempts: 1 }))
    enqueue({ data: DOCUMENT })
    mocked(readDocumentByPlan).mockResolvedValue({ plan: { lane: 'live', allowModel: true, maxModelPages: null }, outcome: { status: 'error', reason: 'reader_unavailable: Request timed out: no answer from the model within 120 s' } })
    enqueue({})
    await run({ now: () => t0 })
    expect(lastJobUpdate()).toMatchObject({ status: 'failed', run_after: new Date(t0 + 30 * 60_000).toISOString() })
  })

  it('ends the read job, out of attempts, when the reader gave the document up, and leaves the report to the reader', async () => {
    const gaveUp = 'read_failed: gave up after 5 readings without an answer: Request timed out'
    claim(job({ kind: 'read', attempts: 3 }))
    enqueue({ data: DOCUMENT })
    mocked(readDocumentByPlan).mockResolvedValue({ plan: { lane: 'live', allowModel: true, maxModelPages: null }, outcome: { status: 'error', reason: gaveUp } })
    enqueue({})
    await expect(run()).resolves.toEqual({ claimed: 1, done: 0, failed: 1 })
    // Failed with no attempts left: no claim takes it again, and the upload surface shows the read as failed.
    expect(lastJobUpdate()).toEqual({ status: 'failed', attempts: 5, last_error: gaveUp, locked_at: null, locked_by: null })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('reports the attempt that gives up as an error and a retry as a warning', async () => {
    claim(job({ kind: 'extract', attempts: 4 }), job({ id: 'job-2', kind: 'extract', attempts: 5 }))
    mocked(extractDocument).mockResolvedValue({ status: 'error', reason: 'model timeout' })
    enqueue({})
    enqueue({})
    await expect(run()).resolves.toMatchObject({ failed: 2 })
    expect(log.warn).toHaveBeenCalledWith('document job failed', expect.objectContaining({ job: 'job-1', attempt: 4 }))
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith('document job gave up', expect.objectContaining({ job: 'job-2', attempt: 5, company: 'co-1', reason: 'model timeout' }))
  })

  it('keeps retrying while no model is configured instead of finishing the job', async () => {
    claim(job({ kind: 'extract' }))
    mocked(extractDocument).mockResolvedValue({ status: 'skipped', reason: 'ai_unconfigured' })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ failed: 1 })
    expect(lastJobUpdate()).toMatchObject({ status: 'failed', last_error: 'ai_unconfigured' })
  })

  it('claims no job once the deadline has passed: the rest stays queued, untouched, for the next tick', async () => {
    // Claimed up front, a killed run left the unstarted jobs running for ten minutes with an attempt spent.
    claim(job({ kind: 'extract' }), job({ id: 'job-2', kind: 'extract', attempts: 2 }))
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'agreement.loan', reviewFields: [] })
    enqueue({})
    const ticks = [0, 100]

    await expect(run({ deadlineAt: 10, now: () => ticks.shift() ?? 100 })).resolves.toEqual({ claimed: 1, done: 1, failed: 0 })
    expect(extractDocument).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls.filter(([name]) => name === 'claim_document_jobs')).toHaveLength(1)
    // The second job was never claimed: nothing to hand back, no attempt to give back.
    expect(due).toEqual([job({ id: 'job-2', kind: 'extract', attempts: 2 })])
    expect(findCalls('document_jobs', 'update')).toEqual([[{ status: 'done', result: 'extracted agreement.loan', last_error: null, locked_at: null, locked_by: null }]])
  })

  it('claims at most its limit of jobs in one run', async () => {
    claim(job({ kind: 'extract' }), job({ id: 'job-2', kind: 'extract' }), job({ id: 'job-3', kind: 'extract' }))
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'generic', reviewFields: [] })
    await expect(run({ limit: 2 })).resolves.toEqual({ claimed: 2, done: 2, failed: 0 })
    expect(due).toHaveLength(1)
  })

  it('queues a derivation after extracting an agreement, and runs it', async () => {
    claim(job({ kind: 'extract' }), job({ id: 'job-2', kind: 'derive', document_id: 'doc-2' }))
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'agreement.loan', reviewFields: [] })
    enqueue({ data: true }) // enqueue derive for doc-1
    enqueue({}) // job-1 done
    mocked(deriveDocument).mockResolvedValue({ status: 'derived', agreementId: 'agr-1', obligations: 14, deadlines: 2, counterparty: 'proven', waitingOn: ['notice_months'] })
    mocked(recordFactsForDocument).mockResolvedValue({ status: 'recorded', facts: 9, subjectKind: 'agreement' })
    enqueue({}) // job-2 done

    await expect(run()).resolves.toEqual({ claimed: 2, done: 2, failed: 0 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'derive' })
    expect(deriveDocument).toHaveBeenCalledWith(supabase, 'doc-2')
    expect(recordFactsForDocument).toHaveBeenCalledWith(supabase, 'doc-2')
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'derived 14 obligations, 2 deadlines, 9 facts, waiting on notice_months' })
    expect(recordArkivUsage).toHaveBeenCalledWith(supabase, 'co-1', 'extractions', 1)
  })

  it('queues a derivation for a registration too (facts), and records facts even when no agreement is derived', async () => {
    claim(job({ kind: 'extract' }), job({ id: 'job-2', kind: 'derive', document_id: 'doc-2' }))
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'registration.bolagsverket', reviewFields: [] })
    enqueue({ data: true })
    enqueue({})
    mocked(deriveDocument).mockResolvedValue({ status: 'skipped', reason: 'not_agreement' })
    mocked(recordFactsForDocument).mockResolvedValue({ status: 'recorded', facts: 12, subjectKind: 'company' })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ done: 2 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', expect.objectContaining({ p_kind: 'derive' }))
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'skipped: not_agreement; 12 facts' })
  })

  it('does not queue a derivation for a record without facts or an agreement', async () => {
    claim(job({ kind: 'extract' }))
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'generic', reviewFields: [] })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ done: 1 })
    expect(rpc).not.toHaveBeenCalledWith('enqueue_document_job', expect.objectContaining({ p_kind: 'derive' }))
  })

  it('throws when the claim fails', async () => {
    enqueue({ data: [] })
    enqueue({ error: { message: 'boom' } })
    await expect(run()).rejects.toThrow('claim failed: boom')
  })

  it('fails jobs abandoned on their last attempt before claiming, and reports them as an error', async () => {
    enqueue({ data: [job({ id: 'dead-1', attempts: 5 }), job({ id: 'dead-2', company_id: 'co-2', attempts: 5 })] })
    enqueue({ data: [] })
    await expect(run()).resolves.toEqual({ claimed: 0, done: 0, failed: 0 })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['fail_abandoned_document_jobs', 'claim_document_jobs'])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith('document jobs abandoned on their last attempt', {
      count: 2, jobs: ['dead-1', 'dead-2'], companies: ['co-1', 'co-2'],
    })
  })

  it('reports nothing when no job was abandoned', async () => {
    claim()
    await run()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('still claims and runs jobs when the sweep fails', async () => {
    enqueue({ error: { message: 'function fail_abandoned_document_jobs does not exist' } })
    enqueue({ data: [job({ kind: 'extract' })] })
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'generic', reviewFields: [] })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ claimed: 1, done: 1 })
    expect(log.error).toHaveBeenCalledWith('abandoned document job sweep failed', { reason: 'function fail_abandoned_document_jobs does not exist' })
  })
})

describe('runDocumentJobFor', () => {
  const t0 = Date.parse('2026-11-13T08:00:00Z')
  const at = (ms: number) => new Date(ms).toISOString()
  const OUTAGE = 'reader_unavailable: 503 Bedrock is unable to process your request.'
  const CUT = "reader_unavailable: Request timed out: the run's time was up 48 s into the model call"
  const CLAIM = { p_document_id: 'doc-1', p_worker: 'pipeline:user-1' }

  it('runs the one due step of a document now and settles it', async () => {
    const { runDocumentJobFor } = await import('../queue')
    const { createQueuedMockSupabase } = await import('@/tests/helpers')
    const local = createQueuedMockSupabase()
    const supabase = local.supabase as unknown as import('@supabase/supabase-js').SupabaseClient
    local.enqueue({ data: [{ status: 'queued', attempts: 0, max_attempts: 5, last_error: null, run_after: at(t0) }] }) // the document's open jobs
    local.enqueue({ data: [] }) // the claim: nothing due
    expect(await runDocumentJobFor(supabase, 'doc-1', 'pipeline:user-1', () => t0)).toBeNull()
    expect(local.supabase.rpc).toHaveBeenLastCalledWith('claim_document_job_for', CLAIM)
  })

  it('leaves a step that ran out of its run\'s time to the worker, due or not: a watcher\'s polls would spend every attempt on it', async () => {
    const { runDocumentJobFor } = await import('../queue')
    const { createQueuedMockSupabase } = await import('@/tests/helpers')
    const local = createQueuedMockSupabase()
    const supabase = local.supabase as unknown as import('@supabase/supabase-js').SupabaseClient
    // Its short wait over or not, the route's minute would cut it again: the worker has five.
    for (const runAfter of [t0 - 60_000, t0 + 60_000]) {
      local.enqueue({ data: [{ status: 'failed', attempts: 2, max_attempts: 5, last_error: CUT, run_after: at(runAfter) }] })
      expect(await runDocumentJobFor(supabase, 'doc-1', 'pipeline:user-1', () => t0)).toBeNull()
    }
    // The claim retries a failed step at once, backoff or not: it is never asked.
    expect(local.supabase.rpc).not.toHaveBeenCalled()
    expect(local.findCalls('document_jobs', 'eq')).toEqual([['document_id', 'doc-1'], ['document_id', 'doc-1']])
  })

  it('leaves a step that failed on the provider to the worker while its wait is still ahead', async () => {
    const { runDocumentJobFor } = await import('../queue')
    const { createQueuedMockSupabase } = await import('@/tests/helpers')
    const local = createQueuedMockSupabase()
    const supabase = local.supabase as unknown as import('@supabase/supabase-js').SupabaseClient
    // A read the reader got no answer for, and a classification the model gave none: both wait out the outage.
    for (const lastError of [OUTAGE, 'provider_unavailable: 503 Bedrock is unable to process your request.']) {
      local.enqueue({ data: [{ status: 'failed', attempts: 1, max_attempts: 5, last_error: lastError, run_after: at(t0 + 1) }] })
      expect(await runDocumentJobFor(supabase, 'doc-1', 'pipeline:user-1', () => t0)).toBeNull()
    }
    // claim_document_job_for takes a failed step at once, backoff or not: asking it would spend an attempt a poll.
    expect(local.supabase.rpc).not.toHaveBeenCalled()
  })

  it('claims a step that failed on the provider once its wait is over, as before', async () => {
    const { runDocumentJobFor } = await import('../queue')
    const { createQueuedMockSupabase } = await import('@/tests/helpers')
    const local = createQueuedMockSupabase()
    const supabase = local.supabase as unknown as import('@supabase/supabase-js').SupabaseClient
    local.enqueue({ data: [{ status: 'failed', attempts: 1, max_attempts: 5, last_error: OUTAGE, run_after: at(t0) }] })
    local.enqueue({ data: [] })
    await runDocumentJobFor(supabase, 'doc-1', 'pipeline:user-1', () => t0)
    expect(local.supabase.rpc).toHaveBeenCalledWith('claim_document_job_for', CLAIM)
  })

  it('still retries at once a step that failed for another reason, wait or not, for the person waiting', async () => {
    const { runDocumentJobFor } = await import('../queue')
    const { createQueuedMockSupabase } = await import('@/tests/helpers')
    const local = createQueuedMockSupabase()
    const supabase = local.supabase as unknown as import('@supabase/supabase-js').SupabaseClient
    local.enqueue({ data: [{ status: 'failed', attempts: 2, max_attempts: 5, last_error: 'insert failed: deadlock detected', run_after: at(t0 + 4 * 60_000) }] })
    local.enqueue({ data: [] })
    await runDocumentJobFor(supabase, 'doc-1', 'pipeline:user-1', () => t0)
    expect(local.supabase.rpc).toHaveBeenCalledWith('claim_document_job_for', CLAIM)
  })

  it('spends one attempt a wait, not one a poll, while a person watches an upload through a provider outage', async () => {
    const { runDocumentJobFor } = await import('../queue')
    // The read job of one document, kept as the database keeps it across polls. The claim does what
    // claim_document_job_for (migration 20260916100000) does: it takes a queued or failed job with attempts
    // left at once, whatever its run_after.
    const row = { id: 'job-1', kind: 'read', status: 'queued', attempts: 0, max_attempts: 5, last_error: null as string | null, run_after: at(t0) }
    interface Query {
      select(): Query
      eq(): Query
      neq(): Query
      maybeSingle(): Query
      update(change: Partial<typeof row>): Query
      then(resolve: (result: { data: unknown; error: null }) => void): void
    }
    const from = (table: string) => {
      let patch: Partial<typeof row> | null = null
      const query: Query = {
        select: () => query,
        eq: () => query,
        neq: () => query,
        maybeSingle: () => query,
        update: (change: Partial<typeof row>) => {
          patch = change
          return query
        },
        then: (resolve: (result: { data: unknown; error: null }) => void) => {
          if (table === 'document_attachments') return resolve({ data: DOCUMENT, error: null })
          if (patch) {
            Object.assign(row, patch)
            return resolve({ data: null, error: null })
          }
          // The document's open jobs: the select leaves out a done one.
          return resolve({ data: row.status === 'done' ? [] : [{ ...row }], error: null })
        },
      }
      return query
    }
    const claim = vi.fn(async () => {
      if (row.attempts >= row.max_attempts || (row.status !== 'queued' && row.status !== 'failed')) return { data: [], error: null }
      Object.assign(row, { status: 'running', attempts: row.attempts + 1 })
      return { data: [{ id: row.id, company_id: 'co-1', document_id: 'doc-1', kind: row.kind, attempts: row.attempts }], error: null }
    })
    const database = { from, rpc: claim } as unknown as SupabaseClient
    mocked(readDocumentByPlan).mockResolvedValue({ plan: { lane: 'live', allowModel: true, maxModelPages: null }, outcome: { status: 'error', reason: OUTAGE } })
    // The upload screen asks every 1.5 s, for a minute at a time.
    const watch = async (start: number) => {
      for (let poll = 0; poll < 40; poll++) await runDocumentJobFor(database, 'doc-1', 'pipeline:user-1', () => start + poll * 1500)
    }

    await watch(t0)
    // One reading, one attempt, then the outage's half hour: before, five polls spent all five and gave the job up.
    expect(readDocumentByPlan).toHaveBeenCalledTimes(1)
    expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: OUTAGE, run_after: at(t0 + 30 * 60_000) })

    // Once the wait is over, a poll asks again, as the worker would: one more attempt, and the next wait is an hour.
    const t1 = t0 + 30 * 60_000
    await watch(t1)
    expect(readDocumentByPlan).toHaveBeenCalledTimes(2)
    expect(row).toMatchObject({ status: 'failed', attempts: 2, run_after: at(t1 + 60 * 60_000) })
    expect(claim).toHaveBeenCalledTimes(2)
    // A retry is a warning; nothing gave up.
    expect(log.error).not.toHaveBeenCalled()
  })

  it('does not let a step out of attempts hold the document: its other steps still run for the person waiting', async () => {
    const { runDocumentJobFor } = await import('../queue')
    const { createQueuedMockSupabase } = await import('@/tests/helpers')
    const local = createQueuedMockSupabase()
    const supabase = local.supabase as unknown as import('@supabase/supabase-js').SupabaseClient
    // Cut by its run on its last attempt: never claimed again, and only re-queueing would clear its last_error.
    local.enqueue({ data: [{ status: 'failed', attempts: 5, max_attempts: 5, last_error: "reader_unavailable: Request timed out: the run's time was up 48 s into the model call" }] })
    local.enqueue({ data: [] })
    await runDocumentJobFor(supabase, 'doc-1', 'pipeline:user-1')
    expect(local.supabase.rpc).toHaveBeenCalledWith('claim_document_job_for', { p_document_id: 'doc-1', p_worker: 'pipeline:user-1' })
  })
})
