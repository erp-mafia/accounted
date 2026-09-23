import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

import { PATCH } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const params = { params: Promise.resolve({ id: 'key-1' }) }

/**
 * Chainable proxy over .update().eq().eq().is().select().maybeSingle().
 * Records the update payload and every .eq()/.is() filter, so the tests can
 * assert on tenant scoping rather than trusting it.
 */
function setupFrom(result: { data?: unknown; error?: unknown }) {
  const updateSpy = vi.fn()
  const filters: Array<[string, unknown]> = []

  mockSupabase.from.mockImplementation(() => {
    const chain: Record<string, unknown> = {}
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'update') {
          return (payload: unknown) => {
            updateSpy(payload)
            return new Proxy(chain, handler)
          }
        }
        if (prop === 'eq' || prop === 'is') {
          return (col: string, val: unknown) => {
            filters.push([col, val])
            return new Proxy(chain, handler)
          }
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () =>
            Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
        }
        return () => new Proxy(chain, handler)
      },
    }
    return new Proxy(chain, handler)
  })

  return { updateSpy, filters }
}

function patch(body: unknown) {
  return createMockRequest('/api/settings/api-keys/key-1', { method: 'PATCH', body })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  getActiveCompanyIdMock.mockResolvedValue('company-1')
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('PATCH /api/settings/api-keys/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(patch({ unattended_commit_limit: 5000 }), params)
    expect(res.status).toBe(401)
  })

  it('sets a ceiling and scopes the update to the active company and unrevoked keys', async () => {
    const { updateSpy, filters } = setupFrom({
      data: { id: 'key-1', unattended_commit_limit: 5000 },
    })
    const res = await PATCH(patch({ unattended_commit_limit: 5000 }), params)
    const { status, body } = await parseJsonResponse<{
      data: { unattended_commit_limit: number }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.unattended_commit_limit).toBe(5000)
    expect(updateSpy).toHaveBeenCalledWith({ unattended_commit_limit: 5000 })
    // Tenant scoping is the whole security story of this route: without the
    // company_id filter, any authenticated user could raise any key's
    // authority by guessing an id.
    expect(filters).toContainEqual(['company_id', 'company-1'])
    expect(filters).toContainEqual(['id', 'key-1'])
    expect(filters).toContainEqual(['revoked_at', null])
  })

  it('accepts null to clear the ceiling', async () => {
    const { updateSpy } = setupFrom({ data: { id: 'key-1', unattended_commit_limit: null } })
    const res = await PATCH(patch({ unattended_commit_limit: null }), params)
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ unattended_commit_limit: null })
  })

  it('rejects zero, negatives and non-numbers with 400', async () => {
    setupFrom({ data: { id: 'key-1' } })
    for (const bad of [0, -1, '5000', {}]) {
      const res = await PATCH(patch({ unattended_commit_limit: bad }), params)
      expect(res.status).toBe(400)
    }
  })

  it('requires the field rather than treating an empty body as "clear it"', async () => {
    setupFrom({ data: { id: 'key-1' } })
    const res = await PATCH(patch({}), params)
    expect(res.status).toBe(400)
  })

  it('returns 404 when the key belongs to another company or is revoked', async () => {
    setupFrom({ data: null })
    const res = await PATCH(patch({ unattended_commit_limit: 5000 }), params)
    expect(res.status).toBe(404)
  })

  it('returns 500 when the update fails', async () => {
    setupFrom({ error: { message: 'boom' } })
    const res = await PATCH(patch({ unattended_commit_limit: 5000 }), params)
    expect(res.status).toBe(500)
  })
})
