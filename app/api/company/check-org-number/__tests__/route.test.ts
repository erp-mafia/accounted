import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { GET } from '../route'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.mocked(createClient)

/**
 * Minimal authenticated-client mock. `companies.data` seeds what the RLS-scoped
 * `from('companies').select().eq().is()` chain resolves to. In production RLS
 * filters this to the caller's own memberships; the route does no extra
 * filtering, so the test just controls what the query returns.
 */
function buildSupabase(opts: {
  user: { id: string } | null
  companies?: { data?: unknown; error?: unknown }
}) {
  const result = {
    data: opts.companies?.data ?? null,
    error: opts.companies?.error ?? null,
  }
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit', 'order']) {
    chain[m] = () => chain
  }
  ;(chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => resolve(result)
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn(() => chain),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/company/check-org-number', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase({ user: null }) as never)
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=5560125790'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when org_number is missing', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase({ user: { id: 'u1' } }) as never)
    const res = await GET(createMockRequest('/api/company/check-org-number'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns exists:false for malformed org_number without querying', async () => {
    const supabase = buildSupabase({ user: { id: 'u1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=not-a-number'))
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; companies: unknown[] }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(false)
    expect(body.data.companies).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it("reports the user's own matching companies (account-scoped via RLS)", async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({
        user: { id: 'u1' },
        companies: { data: [{ id: 'c1', name: 'Acme AB' }] },
      }) as never,
    )
    // Hyphenated input still matches the stored 10-digit canonical.
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=556012-5790'))
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; companies: { id: string; name: string }[] }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(true)
    expect(body.data.companies).toEqual([{ id: 'c1', name: 'Acme AB' }])
  })

  it('returns exists:false when the user has no company with that org number', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ user: { id: 'u1' }, companies: { data: [] } }) as never,
    )
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=5560125790'))
    const { status, body } = await parseJsonResponse<{ data: { exists: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(false)
  })

  it('returns 500 when the query errors', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ user: { id: 'u1' }, companies: { error: { message: 'boom' } } }) as never,
    )
    const res = await GET(createMockRequest('/api/company/check-org-number?org_number=5560125790'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(500)
  })
})
