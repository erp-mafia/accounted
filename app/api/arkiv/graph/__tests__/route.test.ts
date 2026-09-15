import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = () => GET(new Request('http://localhost/api/arkiv/graph'), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/graph', () => {
  it('is 404 outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('builds the hub, the four clusters, the verifikat count and what waits', async () => {
    enqueue({ data: { name: 'Arcim Technology AB' } })
    enqueue({ count: 23 })
    enqueue({ count: 1262 })
    enqueue({ data: [{ id: 'agr-1', title: 'Lån 500050956', kind: 'loan', ends_on: '2031-02-02' }], count: 1 })
    enqueue({ data: [{ id: 'doc-r', file_name: 'Registreringsbevis.pdf', doc_type: 'registration.bolagsverket', created_at: '2026-09-15' }], count: 2 })
    enqueue({ data: [{ party_id: 'p1' }, { party_id: 'p1' }, { party_id: 'p2' }], count: 3 })
    enqueue({ data: [], count: 0 })
    enqueue({ data: [{ id: 'doc-h', file_name: 'IMG_7480.HEIC' }] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'p1', display_name: 'Almi Stockholm AB' }, { id: 'p2', display_name: 'Propel Capital VII AB' }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const graph = (body as { data: Record<string, unknown> }).data
    expect(graph).toMatchObject({ company: { name: 'Arcim Technology AB', document_count: 23 }, verifikat_count: 1262 })
    const clusters = graph.clusters as Array<{ key: string; count: number; nodes: Array<{ href: string }> }>
    expect(clusters.map((c) => [c.key, c.count, c.nodes.length])).toEqual([
      ['avtal', 1, 1],
      ['myndighet', 2, 1],
      ['motparter', 2, 2],
      ['tillgangar', 0, 0],
    ])
    expect(clusters[0].nodes[0].href).toBe('/arkiv/avtal/agr-1')
    expect(graph.waiting).toEqual([{ id: 'doc-h', label: 'IMG_7480.HEIC', href: '/arkiv/granska', meta: 'held' }])
  })
})
