import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { guardSandbox } from '@/lib/sandbox/guard'
import { NextResponse } from 'next/server'

type Body = { data: { source: string | null; document: { id: string } | null; inbox_item_id: string | null; facts: { vat_amount: number | null; supplier: string | null } | null } }

const req = () => new Request('http://localhost/api/transactions/tx-1/underlag')

describe('GET /api/transactions/[id]/underlag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' } as never,
      supabase: mockSupabase as never,
      error: null,
    })
    vi.mocked(guardSandbox).mockResolvedValue(null)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(401)
  })

  it('returns 404 when the transaction is not the company\'s', async () => {
    enqueue({ data: null }) // transaction
    const { status } = await parseJsonResponse(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(404)
  })

  it('returns the pinned document first, with the matched item\'s facts', async () => {
    enqueue({ data: { id: 'tx-1', document_id: 'doc-pinned' } })
    enqueue({ data: { id: 'item-1', document_id: 'doc-matched', extracted_data: { supplier: { name: 'Vercel Inc.' }, totals: { vatAmount: 246.19 } }, kind_hint: null } })
    enqueue({ data: { id: 'doc-pinned', file_name: 'kvitto.pdf', mime_type: 'application/pdf' } })
    const { status, body } = await parseJsonResponse<Body>(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(200)
    expect(body.data.source).toBe('pinned')
    expect(body.data.document?.id).toBe('doc-pinned')
    expect(body.data.inbox_item_id).toBe('item-1')
    expect(body.data.facts?.vat_amount).toBe(246.19)
    expect(body.data.facts?.supplier).toBe('Vercel Inc.')
  })

  it('falls back to the matched inbox document and says so', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null } })
    enqueue({ data: { id: 'item-1', document_id: 'doc-matched', extracted_data: null, kind_hint: 'receipt' } })
    enqueue({ data: { id: 'doc-matched', file_name: 'a.jpg', mime_type: 'image/jpeg' } })
    const { status, body } = await parseJsonResponse<Body>(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(200)
    expect(body.data.source).toBe('matched')
    expect(body.data.document?.id).toBe('doc-matched')
    expect(body.data.facts).toBeNull()
  })

  it('says nothing when there is nothing', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null } })
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<Body>(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(200)
    expect(body.data).toEqual({ source: null, document: null, inbox_item_id: null, facts: null })
  })
})
