import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

import { POST } from '../match/route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/articles/match', { method: 'POST', body })
}

const noParams = { params: Promise.resolve({}) }
const req = (body: unknown) => [makeRequest(body), noParams] as const

type MatchBody = { data: { matches: unknown[]; duplicate_count: number } }

describe('POST /api/import/articles/match', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([
      { id: 'x', name: 'Skruv M6', article_number: 'A-1' },
      { id: 'y', name: 'Konsulttimme', article_number: null },
    ])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(...req({ rows: [{ article_number: 'A-1', name: 'Skruv' }] }))
    expect((await parseJsonResponse<MatchBody>(res)).status).toBe(401)
  })

  it('returns 400 for an empty key list', async () => {
    const res = await POST(...req({ rows: [] }))
    expect((await parseJsonResponse<MatchBody>(res)).status).toBe(400)
  })

  it('returns 400 above the per-call ceiling, so the client batches', async () => {
    const rows = Array.from({ length: 20_001 }, (_, i) => ({ article_number: `N-${i}`, name: 'x' }))
    const res = await POST(...req({ rows }))
    expect((await parseJsonResponse<MatchBody>(res)).status).toBe(400)
  })

  it('answers one match or null per key, in order: number first, then name', async () => {
    const res = await POST(...req({
      rows: [
        { article_number: 'A-1', name: 'Annat namn' },
        { article_number: null, name: '  KONSULTTIMME ' },
        { article_number: 'A-404', name: 'Ny artikel' },
      ],
    }))
    const { status, body } = await parseJsonResponse<MatchBody>(res)

    expect(status).toBe(200)
    expect(body.data.duplicate_count).toBe(2)
    expect(body.data.matches).toEqual([
      { article_id: 'x', matched_by: 'article_number', existing_name: 'Skruv M6' },
      { article_id: 'y', matched_by: 'name', existing_name: 'Konsulttimme' },
      null,
    ])
  })

  it('returns 500 when the article read fails', async () => {
    mockFetchAllRows.mockRejectedValue(new Error('boom'))
    const res = await POST(...req({ rows: [{ article_number: 'A-1', name: 'Skruv' }] }))
    expect((await parseJsonResponse<MatchBody>(res)).status).toBe(500)
  })
})
