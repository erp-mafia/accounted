import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/documents/read/store', () => ({ readAndStoreDocument: vi.fn() }))
vi.mock('@/lib/documents/classify/classify', () => ({
  classifyDocument: vi.fn(),
  loadCompanyIdentity: vi.fn(async () => ({ name: 'Exempelbolaget AB', orgNumber: null })),
}))
vi.mock('@/lib/documents/extract/store', () => ({ extractDocument: vi.fn() }))
vi.mock('@/lib/arkiv/agreements/store', () => ({ deriveDocument: vi.fn() }))
vi.mock('@/lib/arkiv/facts/store', () => ({ recordFactsForDocument: vi.fn() }))

import { enqueueDocumentJob, enqueueMissingExtractions, runDocumentJobs, type ClaimedJob } from '../queue'
import { readAndStoreDocument } from '@/lib/documents/read/store'
import { classifyDocument } from '@/lib/documents/classify/classify'
import { extractDocument } from '@/lib/documents/extract/store'
import { deriveDocument } from '@/lib/arkiv/agreements/store'
import { recordFactsForDocument } from '@/lib/arkiv/facts/store'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc
const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({ id: 'job-1', company_id: 'co-1', document_id: 'doc-1', kind: 'read', attempts: 1, ...over })
const DOCUMENT = { id: 'doc-1', company_id: 'co-1', storage_path: 'documents/co-1/a.pdf', mime_type: 'application/pdf' }
const lastJobUpdate = () => findCalls('document_jobs', 'update').at(-1)?.[0]
const run = (over: Partial<Parameters<typeof runDocumentJobs>[1]> = {}) => runDocumentJobs(supabase, { limit: 8, worker: 'test', budgetMs: 60_000, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'co-1'
})

afterEach(() => {
  delete process.env.ARKIV_COMPANY_IDS
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
    delete process.env.ARKIV_COMPANY_IDS
    await expect(enqueueMissingExtractions(supabase, 20)).resolves.toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('passes the listed companies, or null for everyone', async () => {
    enqueue({ data: 3 })
    await expect(enqueueMissingExtractions(supabase, 20)).resolves.toBe(3)
    expect(rpc).toHaveBeenLastCalledWith('enqueue_missing_document_extractions', { p_company_ids: ['co-1'], p_limit: 20 })
    process.env.ARKIV_COMPANY_IDS = '*'
    enqueue({ data: 0 })
    await enqueueMissingExtractions(supabase, 20)
    expect(rpc).toHaveBeenLastCalledWith('enqueue_missing_document_extractions', { p_company_ids: null, p_limit: 20 })
  })
})

describe('runDocumentJobs', () => {
  it('reads a document, queues its classification and records the outcome', async () => {
    enqueue({ data: [job()] })
    enqueue({ data: DOCUMENT })
    mocked(readAndStoreDocument).mockResolvedValue({ status: 'read', pages: 3, reader: 'pdf_text' })
    enqueue({ data: true })
    enqueue({})

    await expect(run()).resolves.toEqual({ claimed: 1, done: 1, failed: 0, returned: 0 })
    expect(rpc).toHaveBeenCalledWith('claim_document_jobs', { p_batch_size: 8, p_worker: 'test' })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'classify' })
    expect(lastJobUpdate()).toEqual({ status: 'done', result: 'read 3 pages (pdf_text)', last_error: null, locked_at: null, locked_by: null })
  })

  it('reads text for every company but classifies only in the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    enqueue({ data: [job(), job({ id: 'job-2', kind: 'classify' })] })
    enqueue({ data: DOCUMENT })
    mocked(readAndStoreDocument).mockResolvedValue({ status: 'read', pages: 1, reader: 'pdf_text' })
    enqueue({})
    enqueue({})

    await expect(run()).resolves.toMatchObject({ done: 2 })
    expect(rpc).not.toHaveBeenCalledWith('enqueue_document_job', expect.anything())
    expect(classifyDocument).not.toHaveBeenCalled()
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'skipped: not_in_rollout' })
  })

  it('queues extraction for an admitted document and fails a broken extraction with backoff', async () => {
    enqueue({ data: [job({ kind: 'classify' }), job({ id: 'job-2', kind: 'extract', attempts: 3 })] })
    mocked(classifyDocument).mockResolvedValue({ status: 'classified', admission: 'admitted', classification: { doc_type: 'agreement.loan' } })
    enqueue({ data: true })
    enqueue({})
    mocked(extractDocument).mockResolvedValue({ status: 'error', reason: 'model timeout' })
    enqueue({})
    const t0 = Date.parse('2026-09-15T08:00:00Z')

    await expect(run({ now: () => t0 })).resolves.toEqual({ claimed: 2, done: 1, failed: 1, returned: 0 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'extract' })
    expect(lastJobUpdate()).toEqual({ status: 'failed', last_error: 'model timeout', run_after: new Date(t0 + 8 * 60_000).toISOString(), locked_at: null, locked_by: null })
  })

  it('keeps retrying while no model is configured instead of finishing the job', async () => {
    enqueue({ data: [job({ kind: 'extract' })] })
    mocked(extractDocument).mockResolvedValue({ status: 'skipped', reason: 'ai_unconfigured' })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ failed: 1 })
    expect(lastJobUpdate()).toMatchObject({ status: 'failed', last_error: 'ai_unconfigured' })
  })

  it('hands unstarted jobs back without counting the attempt when the budget is spent', async () => {
    enqueue({ data: [job({ kind: 'extract' }), job({ id: 'job-2', kind: 'extract', attempts: 2 })] })
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'agreement.loan', reviewFields: [] })
    enqueue({})
    enqueue({})
    const ticks = [0, 5, 100]

    await expect(run({ budgetMs: 10, now: () => ticks.shift() ?? 100 })).resolves.toEqual({ claimed: 2, done: 1, failed: 0, returned: 1 })
    expect(extractDocument).toHaveBeenCalledTimes(1)
    expect(lastJobUpdate()).toEqual({ status: 'queued', attempts: 1, locked_at: null, locked_by: null })
  })

  it('queues a derivation after extracting an agreement, and runs it', async () => {
    enqueue({ data: [job({ kind: 'extract' }), job({ id: 'job-2', kind: 'derive', document_id: 'doc-2' })] })
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'agreement.loan', reviewFields: [] })
    enqueue({ data: true }) // enqueue derive for doc-1
    enqueue({}) // job-1 done
    mocked(deriveDocument).mockResolvedValue({ status: 'derived', agreementId: 'agr-1', obligations: 14, deadlines: 2, counterparty: 'proven', waitingOn: ['notice_months'] })
    mocked(recordFactsForDocument).mockResolvedValue({ status: 'recorded', facts: 9, subjectKind: 'agreement' })
    enqueue({}) // job-2 done

    await expect(run()).resolves.toEqual({ claimed: 2, done: 2, failed: 0, returned: 0 })
    expect(rpc).toHaveBeenCalledWith('enqueue_document_job', { p_company_id: 'co-1', p_document_id: 'doc-1', p_kind: 'derive' })
    expect(deriveDocument).toHaveBeenCalledWith(supabase, 'doc-2')
    expect(recordFactsForDocument).toHaveBeenCalledWith(supabase, 'doc-2')
    expect(lastJobUpdate()).toMatchObject({ status: 'done', result: 'derived 14 obligations, 2 deadlines, 9 facts, waiting on notice_months' })
  })

  it('queues a derivation for a registration too (facts), and records facts even when no agreement is derived', async () => {
    enqueue({ data: [job({ kind: 'extract' }), job({ id: 'job-2', kind: 'derive', document_id: 'doc-2' })] })
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
    enqueue({ data: [job({ kind: 'extract' })] })
    mocked(extractDocument).mockResolvedValue({ status: 'extracted', schemaType: 'generic', reviewFields: [] })
    enqueue({})
    await expect(run()).resolves.toMatchObject({ done: 1 })
    expect(rpc).not.toHaveBeenCalledWith('enqueue_document_job', expect.objectContaining({ p_kind: 'derive' }))
  })

  it('throws when the claim fails', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(run()).rejects.toThrow('claim failed: boom')
  })
})
