import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/arkiv/graph/snapshot', () => ({ getCompanyGraph: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { getCompanyGraph } from '@/lib/arkiv/graph/snapshot'

const call = () => GET(new Request('http://localhost/api/arkiv/brain'), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/brain', () => {
  it('is 404 outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call())).status).toBe(404)
    expect(getCompanyGraph).not.toHaveBeenCalled()
  })

  it('serves the company graph snapshot, rebuilt through the service client when needed', async () => {
    const graph = { company: { ref: 'company:company-1', name: 'Arcim Technology AB' }, nodes: [{ ref: 'party:p1' }], links: [], clusters: [], months: [], series: {}, truncated: false }
    ;(getCompanyGraph as ReturnType<typeof vi.fn>).mockResolvedValue(graph)
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ data: graph })
    expect(getCompanyGraph).toHaveBeenCalledWith({ tag: 'service' }, 'company-1')
  })

  it('is 500 with a message when the graph cannot be read', async () => {
    ;(getCompanyGraph as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('graph snapshot fetch failed: boom'))
    expect((await parseJsonResponse(await call())).status).toBe(500)
  })
})
