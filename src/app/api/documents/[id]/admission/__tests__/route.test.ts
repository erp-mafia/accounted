import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/core/documents/document-service', () => ({ deleteDocument: vi.fn() }))
vi.mock('@/lib/documents/classify/classify', () => ({ recordHumanClassification: vi.fn() }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { deleteDocument } from '@/lib/core/documents/document-service'
import { recordHumanClassification } from '@/lib/documents/classify/classify'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const call = (body: unknown) =>
  POST(new Request(`http://localhost/api/documents/${DOC}/admission`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: DOC }),
  } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('POST /api/documents/[id]/admission', () => {
  it('returns 401 when not authenticated', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await parseJsonResponse(await call({ decision: 'admit' }))).status).toBe(401)
  })

  it('returns 404 outside the rollout and 400 for a bad body', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call({ decision: 'admit' }))).status).toBe(404)
    process.env.ARKIV_COMPANY_IDS = 'company-1'
    expect((await parseJsonResponse(await call({ decision: 'maybe' }))).status).toBe(400)
  })

  it('returns 404 for a document outside the company and 409 when it is already admitted', async () => {
    enqueue({ data: null, error: null })
    expect((await parseJsonResponse(await call({ decision: 'admit' }))).status).toBe(404)
    enqueue({ data: { id: DOC, admission_state: 'admitted', doc_type: 'receipt', file_name: 'a.pdf' }, error: null })
    expect((await parseJsonResponse(await call({ decision: 'admit' }))).status).toBe(409)
  })

  it('admits a held document as a human decision, keeping the model type', async () => {
    enqueue({ data: { id: DOC, admission_state: 'held', doc_type: 'receipt', file_name: 'a.jpg' }, error: null })
    ;(recordHumanClassification as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'classified', admission: 'admitted' })
    const { status, body } = await parseJsonResponse(await call({ decision: 'admit', reason: 'Lunch med kund' }))
    expect(status).toBe(200)
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ decision: 'admit', doc_type: 'receipt' })
    expect(recordHumanClassification).toHaveBeenCalledWith({ tag: 'service' }, DOC, 'user-1', { docType: 'receipt', relevance: 'relevant', reason: 'Lunch med kund' })
    expect(enqueueDocumentJob).toHaveBeenCalledWith({ tag: 'service' }, 'company-1', DOC, 'extract')
  })

  it('discards a held document through the guarded delete', async () => {
    enqueue({ data: { id: DOC, admission_state: 'held', doc_type: null, file_name: 'semester.jpg' }, error: null })
    ;(deleteDocument as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, document: { id: DOC, file_name: 'semester.jpg' } })
    const { status } = await parseJsonResponse(await call({ decision: 'discard' }))
    expect(status).toBe(200)
    expect(deleteDocument).toHaveBeenCalledWith({ tag: 'service' }, 'company-1', DOC)
    expect(recordHumanClassification).not.toHaveBeenCalled()
    expect(enqueueDocumentJob).not.toHaveBeenCalled()
  })
})
