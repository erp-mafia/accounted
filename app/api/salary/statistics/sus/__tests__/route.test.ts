import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const collectSusCases = vi.fn()
vi.mock('@/lib/salary/statistics/sus-data', () => ({
  collectSusCases: (...args: unknown[]) => collectSusCases(...args),
}))

import { GET } from '../route'

const url = '/api/salary/statistics/sus'

describe('GET /api/salary/statistics/sus', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    collectSusCases.mockResolvedValue({ cases: [] })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1' } }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when month is out of range', async () => {
    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '13' } }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when year and month are missing', async () => {
    const res = await GET(createMockRequest(url))
    expect(res.status).toBe(400)
  })

  it('returns 500 when data collection fails', async () => {
    collectSusCases.mockResolvedValue({ cases: [], error: 'db down' })

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1' } }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'db down' })
  })

  it('scopes data collection to the resolved company and the requested period', async () => {
    enqueue({ data: { org_number: '5560633517' } }) // companies lookup

    await GET(createMockRequest(url, { searchParams: { year: '2026', month: '3' } }))

    expect(collectSusCases).toHaveBeenCalledWith(mockSupabase, 'company-1', 2026, 3)
  })

  it('returns a fixed-position .txt file carrying the org number and personnummer', async () => {
    collectSusCases.mockResolvedValue({
      cases: [{ personnummer: '199001011234', sjukFrom: '2026-01-05', sjukTom: '2026-01-12', ersDays: 6 }],
    })
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('content-disposition')).toContain('SuS_202601.txt')

    const text = await res.text()
    expect(text).toContain('165560633517') // "16" + 10-digit org → PeOrgNr
    expect(text).toContain('199001011234') // personnummer
    expect(text).toContain('2026010520260112') // SjukFrom + SjukTom
  })

  it('returns a JSON envelope when format=json (empty month → org-only file)', async () => {
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1', format: 'json' } }))
    const { status, body } = await parseJsonResponse<{ data: { content: string; recordCount: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.recordCount).toBe(0)
    expect(body.data.content).toBe('165560633517')
  })

  it('falls back to a zero-padded PeOrgNr when the company has no org number', async () => {
    enqueue({ data: { org_number: null } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1', format: 'json' } }))
    const { body } = await parseJsonResponse<{ data: { content: string } }>(res)

    expect(body.data.content).toBe('160000000000')
  })

  it('uses the personnummer PeOrgNr form for an enskild firma', async () => {
    // EF identified by a 10-digit personnummer → century + pnr, not the 16-prefix.
    enqueue({ data: { org_number: '7710030000', entity_type: 'enskild_firma' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2024', month: '1', format: 'json' } }))
    const { body } = await parseJsonResponse<{ data: { content: string } }>(res)

    expect(body.data.content).toBe('197710030000') // 19 (century) + 7710030000
  })
})
