import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/classify/classify', () => ({ recordHumanClassification: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { recordHumanClassification } from '@/lib/documents/classify/classify'

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
  })

  it('returns 404 for a document that is not the company\'s', async () => {
    enqueue({ data: null, error: null })
    expect((await parseJsonResponse(await call({ doc_type: 'receipt' }))).status).toBe(404)
    expect(recordHumanClassification).not.toHaveBeenCalled()
  })
})
