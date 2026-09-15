import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = () => GET(new Request('http://localhost/api/arkiv/review'), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/review', () => {
  it('is not there outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = ''
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('returns the held documents with their reason and the admitted ones the model could not type', async () => {
    // held documents
    enqueue({ data: [{ id: 'h1', file_name: 'semester.jpg', created_at: '2026-09-14T10:00:00Z', page_count: 1, doc_type: 'other' }], error: null })
    // uncertain current model classifications (held one + one admitted 'other')
    enqueue({
      data: [
        { document_id: 'h1', doc_type: 'other', confidence: 0.4, relevance: 'ask', relevance_reason: 'Ingen koppling till bolaget.', addressed_to: null, summary: 'Ett foto.', suggested_type: 'foto' },
        { document_id: 'u1', doc_type: 'other', confidence: 0.5, relevance: 'relevant', relevance_reason: 'Rör bolaget.', addressed_to: 'Exempelbolaget AB', summary: 'Något om bolaget.', suggested_type: 'intyg' },
      ],
      error: null,
    })
    // the admitted documents behind the uncertain ids
    enqueue({ data: [{ id: 'u1', file_name: 'intyg.pdf', created_at: '2026-09-13T10:00:00Z', page_count: 2, doc_type: 'other' }], error: null })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const data = (body as { data: { held: Array<Record<string, unknown>>; unclassified: Array<Record<string, unknown>> } }).data
    expect(data.held).toHaveLength(1)
    expect(data.held[0]).toMatchObject({ document_id: 'h1', relevance: 'ask', relevance_reason: 'Ingen koppling till bolaget.' })
    expect(data.unclassified).toHaveLength(1)
    expect(data.unclassified[0]).toMatchObject({ document_id: 'u1', suggested_type: 'intyg' })
  })
})
