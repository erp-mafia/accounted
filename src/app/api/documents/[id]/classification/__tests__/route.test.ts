import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/classify/classify', () => ({ recordHumanClassification: vi.fn() }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn() }))
vi.mock('@/lib/arkiv/agreements/store', () => ({ withdrawDerivedAgreement: vi.fn(async () => ({ status: 'skipped', reason: 'no_agreement' })) }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { recordHumanClassification } from '@/lib/documents/classify/classify'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { withdrawDerivedAgreement } from '@/lib/arkiv/agreements/store'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const call = (body: unknown) =>
  POST(new Request(`http://localhost/api/documents/${DOC}/classification`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: DOC }),
  } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('POST /api/documents/[id]/classification', () => {
  it('rejects a type outside the taxonomy', async () => {
    expect((await parseJsonResponse(await call({ doc_type: 'spaceship' }))).status).toBe(400)
  })

  it('records the person\'s type as the current classification', async () => {
    enqueue({ data: { id: DOC }, error: null })
    ;(recordHumanClassification as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'classified', admission: 'admitted' })
    const { status, body } = await parseJsonResponse(await call({ doc_type: 'agreement.loan' }))
    expect(status).toBe(200)
    expect((body as { data: Record<string, unknown> }).data).toEqual({ document_id: DOC, doc_type: 'agreement.loan' })
    expect(recordHumanClassification).toHaveBeenCalledWith({ tag: 'service' }, DOC, 'user-1', { docType: 'agreement.loan', relevance: 'relevant' })
    expect(enqueueDocumentJob).toHaveBeenCalledWith({ tag: 'service' }, 'company-1', DOC, 'extract')
  })

  it('withdraws what the old type derived before re-extracting, and refuses to save half a correction', async () => {
    enqueue({ data: { id: DOC }, error: null })
    ;(recordHumanClassification as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'classified', admission: 'admitted' })
    ;(withdrawDerivedAgreement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'withdrawn', agreementId: 'agr-1', facts: 7, deadlines: 1 })
    expect((await parseJsonResponse(await call({ doc_type: 'supplier_invoice' }))).status).toBe(200)
    expect(withdrawDerivedAgreement).toHaveBeenCalledWith({ tag: 'service' }, DOC, 'supplier_invoice', expect.stringContaining('supplier_invoice'))
    expect(enqueueDocumentJob).toHaveBeenCalledWith({ tag: 'service' }, 'company-1', DOC, 'extract')

    enqueue({ data: { id: DOC }, error: null })
    ;(withdrawDerivedAgreement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'error', reason: 'agreement delete failed: boom' })
    const { status, body } = await parseJsonResponse(await call({ doc_type: 'supplier_invoice' }))
    expect(status).toBe(500)
    expect(body).toEqual({ error: 'agreement delete failed: boom' })
    // The old type stays: nothing was saved before the withdrawal succeeded.
    expect(recordHumanClassification).toHaveBeenCalledTimes(1)
    expect(enqueueDocumentJob).toHaveBeenCalledTimes(1)
  })

  it('returns 404 for a document that is not the company\'s', async () => {
    enqueue({ data: null, error: null })
    expect((await parseJsonResponse(await call({ doc_type: 'receipt' }))).status).toBe(404)
    expect(recordHumanClassification).not.toHaveBeenCalled()
    expect(enqueueDocumentJob).not.toHaveBeenCalled()
  })
})
