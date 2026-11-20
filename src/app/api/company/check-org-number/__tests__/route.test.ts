import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import * as route from '../route'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.mocked(createClient)

/**
 * Minimal authenticated-client mock. `memberships.data` seeds what the
 * `from('company_members').select().eq().eq().is()` chain resolves to. In
 * production the filters and RLS narrow it to the caller's own live
 * memberships with that org number; the test controls what the query returns
 * and records the filters the route sent.
 */
function buildSupabase(opts: {
  user: { id: string } | null
  memberships?: { data?: unknown; error?: unknown }
}) {
  const result = {
    data: opts.memberships?.data ?? null,
    error: opts.memberships?.error ?? null,
  }
  const calls: Array<[string, ...unknown[]]> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit', 'order']) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, ...args])
      return chain
    }
  }
  ;(chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => resolve(result)
  return {
    calls,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    from: vi.fn(() => chain),
  }
}

/** One company_members row as PostgREST embeds it. */
function membership(company: { id: string; name: string; created_at: string | null; settingsName?: string | null }, role = 'owner') {
  return {
    role,
    companies: {
      id: company.id,
      name: company.name,
      created_at: company.created_at,
      org_number: '5560125790',
      archived_at: null,
      company_settings: company.settingsName === undefined ? null : { company_name: company.settingsName },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

const { POST } = route

/** The org number goes in the body: a sole trader's is the owner's personnummer (#95). */
function check(orgNumber?: string): Request {
  return createMockRequest('/api/company/check-org-number', {
    method: 'POST',
    body: orgNumber === undefined ? {} : { org_number: orgNumber },
  })
}

describe('POST /api/company/check-org-number', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase({ user: null }) as never)
    const res = await POST(check('5560125790'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when org_number is missing', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase({ user: { id: 'u1' } }) as never)
    const res = await POST(check())
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns exists:false for malformed org_number without querying', async () => {
    const supabase = buildSupabase({ user: { id: 'u1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    const res = await POST(check('not-a-number'))
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; companies: unknown[] }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(false)
    expect(body.data.companies).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it("reports the user's own matching company with role and created time", async () => {
    const supabase = buildSupabase({
      user: { id: 'u1' },
      memberships: { data: [membership({ id: 'c1', name: 'Acme AB', created_at: '2026-03-12T09:30:00+00:00' })] },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    // Hyphenated input still matches the stored 10-digit canonical.
    const res = await POST(check('556012-5790'))
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; companies: { id: string; name: string; role: string; created_at: string }[] }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(true)
    expect(body.data.companies).toEqual([
      { id: 'c1', name: 'Acme AB', role: 'owner', created_at: '2026-03-12T09:30:00+00:00' },
    ])
  })

  it("reads only the caller's own live memberships with that org number", async () => {
    const supabase = buildSupabase({ user: { id: 'u1' }, memberships: { data: [] } })
    mockCreateClient.mockResolvedValue(supabase as never)
    await POST(check('556012-5790'))
    expect(supabase.from).toHaveBeenCalledWith('company_members')
    expect(supabase.calls).toContainEqual(['eq', 'user_id', 'u1'])
    expect(supabase.calls).toContainEqual(['eq', 'companies.org_number', '5560125790'])
    expect(supabase.calls).toContainEqual(['is', 'companies.archived_at', null])
  })

  it('returns two copies of one company oldest first, whatever order the database gave', async () => {
    const supabase = buildSupabase({
      user: { id: 'u1' },
      memberships: {
        data: [
          membership({ id: 'c-new', name: 'Acme AB', created_at: '2026-10-02T14:05:00+00:00' }, 'admin'),
          membership({ id: 'c-old', name: 'Acme AB (gamla)', created_at: '2025-01-15T08:00:00+00:00', settingsName: 'Acme AB' }),
        ],
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    const res = await POST(check('5560125790'))
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; companies: { id: string; name: string; role: string; created_at: string }[] }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(true)
    expect(body.data.companies).toEqual([
      // The display name (company_settings) wins over the stored companies.name.
      { id: 'c-old', name: 'Acme AB', role: 'owner', created_at: '2025-01-15T08:00:00+00:00' },
      { id: 'c-new', name: 'Acme AB', role: 'admin', created_at: '2026-10-02T14:05:00+00:00' },
    ])
  })

  it('returns exists:false when the user has no company with that org number', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ user: { id: 'u1' }, memberships: { data: [] } }) as never,
    )
    const res = await POST(check('5560125790'))
    const { status, body } = await parseJsonResponse<{ data: { exists: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.exists).toBe(false)
  })

  it('returns 500 when the query errors', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ user: { id: 'u1' }, memberships: { error: { message: 'boom' } } }) as never,
    )
    const res = await POST(check('5560125790'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(500)
  })

  it('answers no GET: the org number never travels in the URL (#95)', () => {
    expect('GET' in route).toBe(false)
  })

  it('returns 400 for a body that is not JSON', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase({ user: { id: 'u1' } }) as never)
    const res = await POST(
      new Request('http://localhost:3000/api/company/check-org-number', { method: 'POST', body: 'org_number=5560125790' }),
    )
    expect(res.status).toBe(400)
  })
})
