import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const req = (qs: string) => new Request(`http://localhost/api/documents/search${qs}`)
// The wrapped handler's second parameter is the Next route context; unused here.
const call = (r: Request) => GET(r, {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/documents/search', () => {
  it('returns 401 when not authenticated', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await parseJsonResponse(await call(req('?q=hyra')))).status).toBe(401)
  })

  it('returns 400 for a missing or too short query', async () => {
    expect((await parseJsonResponse(await call(req('')))).status).toBe(400)
    expect((await parseJsonResponse(await call(req('?q=h')))).status).toBe(400)
  })

  it('returns ranked hits from the search RPC for the active company', async () => {
    enqueue({
      data: [{ document_id: 'd1', page_no: 2, file_name: 'hyresavtal.pdf', rank: 0.4, headline: 'Hyran uppgår till <b>19 300</b> kr' }],
      error: null,
    })
    const res = await call(req('?q=19%20300&limit=5'))
    const { status, body } = await parseJsonResponse(res)
    const hits = (body as { data: Array<Record<string, unknown>> }).data
    expect(status).toBe(200)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ document_id: 'd1', page_no: 2 })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('search_document_pages', { p_company_id: 'company-1', p_query: '19 300', p_limit: 5 })
  })

  it('returns 500 with a user-facing message when the RPC fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const { status } = await parseJsonResponse(await call(req('?q=hyra')))
    expect(status).toBe(500)
  })
})
