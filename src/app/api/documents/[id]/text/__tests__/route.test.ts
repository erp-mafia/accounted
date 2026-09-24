import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/read/on-demand', () => ({ ensureDocumentRead: vi.fn(async () => ({ status: 'skipped', reason: 'already_read' })) }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { ensureDocumentRead } from '@/lib/documents/read/on-demand'

const DOC = '11111111-1111-4111-8111-111111111111'
const call = () => GET(new Request(`http://localhost/api/documents/${DOC}/text`), { params: Promise.resolve({ id: DOC }) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/documents/[id]/text', () => {
  it('is 404 for a document that is not the company\'s', async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).status).toBe(404)
    expect(ensureDocumentRead).not.toHaveBeenCalled()
  })

  it('reads on demand what the lanes left, then returns the pages', async () => {
    enqueue({ data: { id: DOC, page_count: 2 } })
    enqueue({ data: [{ page_no: 1, text: 'Sida ett', reader: 'pdf_text' }, { page_no: 2, text: 'Sida två', reader: 'claude_vision' }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ data: { document_id: DOC, page_count: 2, pages: [{ page_no: 1, text: 'Sida ett', reader: 'pdf_text' }, { page_no: 2, text: 'Sida två', reader: 'claude_vision' }], truncated: false } })
    expect(ensureDocumentRead).toHaveBeenCalledWith({ tag: 'service' }, 'company-1', DOC)
  })

  it('still answers with what is stored when the on-demand read fails', async () => {
    ;(ensureDocumentRead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('storage down'))
    enqueue({ data: { id: DOC, page_count: 1 } })
    enqueue({ data: [{ page_no: 1, text: 'Sida ett', reader: 'pdf_text' }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect((body as { data: { pages: unknown[] } }).data.pages).toHaveLength(1)
  })
})
