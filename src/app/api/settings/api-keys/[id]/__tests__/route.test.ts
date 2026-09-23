import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

// api_key_companies is a service-role table and replace_api_key_allowlist is
// service-role only: the route replaces the set through createServiceClient
// (one RPC, one transaction), never through the session client.
const serviceSupabase = {
  from: vi.fn(),
  rpc: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => serviceSupabase,
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

const listUserCompaniesForPickerMock = vi.fn()
vi.mock('@/lib/company/company-picker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/company/company-picker')>()
  return {
    ...actual,
    listUserCompaniesForPicker: (...args: unknown[]) => listUserCompaniesForPickerMock(...args),
  }
})

import { PATCH } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const params = { params: Promise.resolve({ id: 'key-1' }) }

const ACTIVE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const THIRD = '33333333-3333-4333-8333-333333333333'
const FOREIGN = '99999999-9999-4999-8999-999999999999'
const memberships = [
  { company_id: ACTIVE, name: 'Aktiva AB', role: 'owner' },
  { company_id: OTHER, name: 'Andra AB', role: 'owner' },
  { company_id: THIRD, name: 'Tredje AB', role: 'member' },
]

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

/** Service-role stub: records every call per table, resolves per-table results. */
function setupServiceFrom(results: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  serviceSupabase.from.mockImplementation((table: string) => {
    const result = { data: results[table]?.data ?? null, error: results[table]?.error ?? null }
    const chain: Record<string, unknown> = {}
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          return new Proxy(chain, handler)
        }
      },
    }
    return new Proxy(chain, handler)
  })
  const find = (method: string) => calls.find((c) => c.table === 'api_key_companies' && c.method === method)?.args
  const findAll = (method: string) =>
    calls.filter((c) => c.table === 'api_key_companies' && c.method === method).map((c) => c.args)
  return { calls, find, findAll }
}

function patch(body: unknown) {
  return createMockRequest('/api/settings/api-keys/key-1', { method: 'PATCH', body })
}

/** Named arguments of the replace_api_key_allowlist call. */
function replaceArgs(): Record<string, unknown> {
  const call = serviceSupabase.rpc.mock.calls.find((c) => c[0] === 'replace_api_key_allowlist')
  expect(call).toBeDefined()
  return call![1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  getActiveCompanyIdMock.mockResolvedValue('company-1')
  requireWritePermissionMock.mockResolvedValue({ ok: true })
  listUserCompaniesForPickerMock.mockResolvedValue([{ company_id: 'company-1', name: 'Test AB', role: 'owner' }])
  setupServiceFrom()
  serviceSupabase.rpc.mockResolvedValue({ data: 1, error: null })
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
    // The limit alone never touches the allowlist.
    expect(serviceSupabase.from).not.toHaveBeenCalled()
    expect(serviceSupabase.rpc).not.toHaveBeenCalled()
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

  it('requires a field rather than treating an empty body as "clear it"', async () => {
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

  describe('company_ids (per-key company allowlist)', () => {
    beforeEach(() => {
      getActiveCompanyIdMock.mockResolvedValue(ACTIVE)
      listUserCompaniesForPickerMock.mockResolvedValue(memberships)
    })

    it('returns 400 for an empty list rather than widening the key to unrestricted', async () => {
      setupFrom({ data: { id: 'key-1' } })
      const res = await PATCH(patch({ company_ids: [] }), params)
      expect(res.status).toBe(400)
      expect(serviceSupabase.from).not.toHaveBeenCalled()
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns 400 for a non-uuid company id', async () => {
      setupFrom({ data: { id: 'key-1' } })
      const res = await PATCH(patch({ company_ids: ['nope'] }), params)
      expect(res.status).toBe(400)
      expect(serviceSupabase.from).not.toHaveBeenCalled()
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns 403 FORBIDDEN for a company the caller is not a member of', async () => {
      setupFrom({ data: { id: 'key-1' } })
      const res = await PATCH(patch({ company_ids: [ACTIVE, FOREIGN] }), params)
      const { status, body } = await parseJsonResponse<{ error: { code: string; details: { company_ids: string[] } } }>(res)
      expect(status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.details.company_ids).toEqual([FOREIGN])
      expect(serviceSupabase.from).not.toHaveBeenCalled()
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns 404 when the key is not this company\'s live key, before touching the allowlist', async () => {
      setupFrom({ data: null })
      const res = await PATCH(patch({ company_ids: [ACTIVE] }), params)
      expect(res.status).toBe(404)
      expect(serviceSupabase.from).not.toHaveBeenCalled()
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns 400 when the subset drops the company the key is listed under', async () => {
      setupFrom({ data: { id: 'key-1' } })
      const res = await PATCH(patch({ company_ids: [OTHER] }), params)
      const { status, body } = await parseJsonResponse<{ error: { code: string; details: { reason: string } } }>(res)
      expect(status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details.reason).toBe('key_company_required')
      expect(serviceSupabase.from).not.toHaveBeenCalled()
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('replaces the set for a strict subset through one RPC call', async () => {
      const { filters } = setupFrom({ data: { id: 'key-1' } })
      const service = setupServiceFrom()
      const res = await PATCH(patch({ company_ids: [THIRD, ACTIVE] }), params)
      const { status, body } = await parseJsonResponse<{ data: { id: string; company_ids: string[] | null } }>(res)
      expect(status).toBe(200)
      expect(body.data).toEqual({ id: 'key-1', company_ids: [ACTIVE, THIRD] })

      // The key lookup is tenant-scoped like the limit update.
      expect(filters).toContainEqual(['company_id', ACTIVE])
      expect(filters).toContainEqual(['id', 'key-1'])
      expect(filters).toContainEqual(['revoked_at', null])

      // One transaction: delete-outside + insert-missing happen inside the
      // RPC, never as separate upsert and prune requests that could leave
      // the key at the union of the old and new sets.
      expect(serviceSupabase.rpc).toHaveBeenCalledTimes(1)
      expect(replaceArgs()).toEqual({ p_api_key_id: 'key-1', p_company_ids: [ACTIVE, THIRD] })
      expect(service.calls).toEqual([])
    })

    it('clears every row for null (unrestricted)', async () => {
      setupFrom({ data: { id: 'key-1' } })
      const service = setupServiceFrom()
      serviceSupabase.rpc.mockResolvedValue({ data: 0, error: null })
      const res = await PATCH(patch({ company_ids: null }), params)
      const { status, body } = await parseJsonResponse<{ data: { company_ids: string[] | null } }>(res)
      expect(status).toBe(200)
      expect(body.data.company_ids).toBeNull()
      expect(replaceArgs()).toEqual({ p_api_key_id: 'key-1', p_company_ids: null })
      expect(service.calls).toEqual([])
    })

    it('treats the full membership set like null: no rows kept', async () => {
      setupFrom({ data: { id: 'key-1' } })
      serviceSupabase.rpc.mockResolvedValue({ data: 0, error: null })
      const res = await PATCH(patch({ company_ids: [THIRD, OTHER, ACTIVE] }), params)
      const { status, body } = await parseJsonResponse<{ data: { company_ids: string[] | null } }>(res)
      expect(status).toBe(200)
      expect(body.data.company_ids).toBeNull()
      expect(replaceArgs()).toEqual({ p_api_key_id: 'key-1', p_company_ids: null })
    })

    it('answers 500 when the RPC fails (the old set is untouched by construction)', async () => {
      setupFrom({ data: { id: 'key-1' } })
      const service = setupServiceFrom()
      serviceSupabase.rpc.mockResolvedValue({ data: null, error: { message: 'boom', code: '42501' } })
      const res = await PATCH(patch({ company_ids: [ACTIVE] }), params)
      const { status, body } = await parseJsonResponse<{ error: { code: string }; data?: unknown }>(res)
      expect(status).toBe(500)
      expect(body.error.code).toBe('INTERNAL_ERROR')
      expect(body.data).toBeUndefined()
      // No fallback writes around the RPC: nothing to compensate.
      expect(service.calls).toEqual([])
    })

    it('updates both fields in one call', async () => {
      const { updateSpy } = setupFrom({ data: { id: 'key-1', unattended_commit_limit: 900 } })
      const res = await PATCH(patch({ unattended_commit_limit: 900, company_ids: [ACTIVE] }), params)
      const { status, body } = await parseJsonResponse<{ data: { id: string; unattended_commit_limit: number; company_ids: string[] | null } }>(res)
      expect(status).toBe(200)
      expect(body.data).toEqual({ id: 'key-1', unattended_commit_limit: 900, company_ids: [ACTIVE] })
      expect(updateSpy).toHaveBeenCalledWith({ unattended_commit_limit: 900 })
      expect(replaceArgs()).toEqual({ p_api_key_id: 'key-1', p_company_ids: [ACTIVE] })
    })
  })
})
