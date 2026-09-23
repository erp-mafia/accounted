import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/ai', () => ({ getAiStatus: vi.fn(() => ({ configured: true })) }))
vi.mock('../extract', () => ({ EXTRACTOR: { name: 'arkiv.extract', version: '1' }, readFields: vi.fn() }))
vi.mock('@/lib/documents/provenance', () => ({
  softwareAgent: vi.fn(async () => 'agent-software'),
  humanAgent: vi.fn(async () => 'agent-person'),
  recordActivity: vi.fn(async () => 'activity-1'),
}))

import { extractDocument, recordHumanFields } from '../store'
import { getAiStatus } from '@/lib/ai'
import { readFields } from '../extract'
import { humanAgent, recordActivity } from '@/lib/documents/provenance'
import type { ExtractedField } from '../fields'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCall } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc

const company = { name: 'Exempelbolaget AB', orgNumber: null }
const DOC = { id: 'doc-1', company_id: 'co-1', file_name: 'skuldebrev.pdf', doc_type: 'agreement.loan', admission_state: 'admitted' }
const field = (value: string | number | null, over: Partial<ExtractedField> = {}): ExtractedField => ({
  value,
  normalized: value,
  page: 1,
  quote: null,
  bbox: null,
  confidence: 1,
  method: 'consensus',
  readings: [],
  ...over,
})
const current = (over: Record<string, unknown> = {}) => ({ id: 'ext-1', schema_type: 'agreement.loan', schema_version: 1, pass: 'consensus', payload: {}, review_fields: [], ...over })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('extractDocument', () => {
  it('waits for a configured model', async () => {
    ;(getAiStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce({ configured: false })
    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'ai_unconfigured' })
    expect(readFields).not.toHaveBeenCalled()
  })

  it('skips a missing, held or untyped document', async () => {
    enqueue({ data: null })
    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'not_found' })
    enqueue({ data: { ...DOC, admission_state: 'held' } })
    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'not_admitted' })
    enqueue({ data: { ...DOC, doc_type: null } })
    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'no_type' })
  })

  it('leaves a current record of the same schema alone: a person\'s always, a model\'s until the version moves', async () => {
    enqueue({ data: DOC })
    enqueue({ data: current() })
    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'up_to_date' })
    enqueue({ data: DOC })
    enqueue({ data: current({ pass: 'human', schema_version: 0 }) })
    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'up_to_date' })
    expect(readFields).not.toHaveBeenCalled()
  })

  it('skips a document without text', async () => {
    enqueue({ data: DOC })
    enqueue({ data: null })
    enqueue({ data: [{ page_no: 1, text: '  ', words: null }] })
    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'no_text' })
  })

  it('reads a retyped document again and saves the run on top of the previous record', async () => {
    enqueue({ data: DOC })
    enqueue({ data: current({ schema_type: 'agreement.rental', pass: 'human' }) })
    enqueue({ data: [{ page_no: 1, text: 'Skuldebrev', words: null }] })
    ;(readFields as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { principal: field(1_000_000) },
      checks: [],
      reviewFields: ['interest_rate'],
      modelIds: ['sonnet', 'haiku'],
      promptSha256: 'f'.repeat(64),
      pagesSent: [1],
    })
    enqueue({ data: null }) // autonomy level: none earned yet
    enqueue({ error: null }) // schema registration
    enqueue({ data: 'ext-2' }) // save

    expect(await extractDocument(supabase, 'doc-1', company)).toEqual({ status: 'extracted', extractionId: 'ext-2', schemaType: 'agreement.loan', reviewFields: ['interest_rate'] })
    expect(readFields).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'skuldebrev.pdf', pages: [{ pageNo: 1, text: 'Skuldebrev', words: null }] }))
    expect(findCall('extraction_schemas', 'upsert')?.[0]).toMatchObject({ schema_type: 'agreement.loan', version: 1 })
    expect(recordActivity).toHaveBeenCalledWith(supabase, expect.objectContaining({
      companyId: 'co-1',
      documentId: 'doc-1',
      agentId: 'agent-software',
      kind: 'extract',
      modelIds: ['sonnet', 'haiku'],
      outcome: 'review',
      detail: { pages_sent: [1] },
    }))
    expect(rpc).toHaveBeenCalledWith('save_document_extraction', expect.objectContaining({
      p_document_id: 'doc-1',
      p_supersedes_id: 'ext-1',
      p_activity_id: 'activity-1',
      p_schema_type: 'agreement.loan',
      p_pass: 'consensus',
      p_validation: [],
      p_review_fields: ['interest_rate'],
    }))
  })

  it('reports a refused save as an error', async () => {
    enqueue({ data: DOC })
    enqueue({ data: null })
    enqueue({ data: [{ page_no: 1, text: 'Skuldebrev', words: null }] })
    ;(readFields as ReturnType<typeof vi.fn>).mockResolvedValue({ payload: {}, checks: [], reviewFields: [], modelIds: [], promptSha256: '', pagesSent: [1] })
    enqueue({ data: null })
    enqueue({ error: null })
    enqueue({ error: { message: 'extraction of document doc-1 changed since it was read' } })
    const out = await extractDocument(supabase, 'doc-1', company)
    expect(out.status).toBe('error')
    expect(out).toMatchObject({ reason: expect.stringContaining('changed since it was read') })
  })
})

describe('recordHumanFields', () => {
  it('needs a record to settle and fields from its schema', async () => {
    enqueue({ data: DOC })
    enqueue({ data: null })
    expect(await recordHumanFields(supabase, 'doc-1', 'user-1', { interest_rate: 11 })).toEqual({ status: 'skipped', reason: 'no_extraction' })
    enqueue({ data: DOC })
    enqueue({ data: current() })
    expect(await recordHumanFields(supabase, 'doc-1', 'user-1', { shoe_size: 44 })).toEqual({ status: 'skipped', reason: 'unknown_fields' })
    expect(humanAgent).not.toHaveBeenCalled()
  })

  it('settles the given fields as the person\'s and keeps what still needs a person in review', async () => {
    enqueue({ data: DOC })
    enqueue({
      data: current({
        payload: {
          lender_name: field('Almi AB'),
          lender_org_number: field('5560167452'),
          principal: field(1_000_000),
          interest_rate: field(11.1, { page: 3, readings: [{ value: 11.1, page: 3, quote: null }, { value: 11.03, page: 3, quote: null }] }),
        },
        review_fields: ['interest_rate', 'lender_org_number'],
      }),
    })
    enqueue({ data: 'ext-2' })

    const out = await recordHumanFields(supabase, 'doc-1', 'user-1', { interest_rate: '11,03' })

    expect(out).toEqual({ status: 'extracted', extractionId: 'ext-2', schemaType: 'agreement.loan', reviewFields: ['lender_org_number'] })
    expect(humanAgent).toHaveBeenCalledWith(supabase, 'user-1')
    expect(recordActivity).toHaveBeenCalledWith(supabase, expect.objectContaining({ kind: 'review', agentId: 'agent-person', outcome: 'review', detail: { fields: ['interest_rate'] } }))
    const [, args] = rpc.mock.calls.at(-1) as [string, Record<string, { interest_rate?: unknown }>]
    expect(args).toMatchObject({ p_pass: 'human', p_supersedes_id: 'ext-1', p_schema_version: 1, p_validation: [{ check: 'orgnr_luhn', field: 'lender_org_number' }] })
    expect(args.p_payload.interest_rate).toMatchObject({ value: '11,03', normalized: 11.03, page: 3, confidence: 1, method: 'human' })
  })

  it('records whether an audited field was changed, so the autonomy ladder can count it', async () => {
    const audited = () =>
      current({
        payload: { lender_name: field('Almi AB'), principal: field(1_000_000, { readings: [{ value: 1_000_000, page: 1, quote: null }] }) },
        validation: [{ check: 'audit', field: 'principal' }],
        review_fields: ['principal'],
      })
    enqueue({ data: DOC })
    enqueue({ data: audited() })
    enqueue({ data: 'ext-2' })
    await recordHumanFields(supabase, 'doc-1', 'user-1', { principal: '1000000' })
    expect(recordActivity).toHaveBeenLastCalledWith(supabase, expect.objectContaining({ detail: { fields: ['principal'], audit: { field: 'principal', changed: false } } }))

    enqueue({ data: DOC })
    enqueue({ data: audited() })
    enqueue({ data: 'ext-3' })
    await recordHumanFields(supabase, 'doc-1', 'user-1', { principal: '900000' })
    expect(recordActivity).toHaveBeenLastCalledWith(supabase, expect.objectContaining({ detail: { fields: ['principal'], audit: { field: 'principal', changed: true } } }))
  })
})
