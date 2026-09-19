import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

// ── Mocks ──────────────────────────────────────────────────────────
// withRouteContext resolves auth via requireAuth (createClient under the hood),
// the active company via getActiveCompanyId, and the write gate via
// requireWritePermission. Mock all three so we can drive each branch.

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

// api_key_companies is a service-role table and the atomic create RPC is
// service-role only: the routes read the allowlist and mint keys through
// createServiceClient, never through the session client.
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

import { GET, POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
// Static route: withRouteContext still types the second handler argument.
const noParams = { params: Promise.resolve({}) }

const ACTIVE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const THIRD = '33333333-3333-4333-8333-333333333333'
const FOREIGN = '99999999-9999-4999-8999-999999999999'
const memberships = [
  { company_id: ACTIVE, name: 'Aktiva AB', role: 'owner' },
  { company_id: OTHER, name: 'Andra AB', role: 'owner' },
  { company_id: THIRD, name: 'Tredje AB', role: 'member' },
]

// Session-client stub: the quota pre-check (.select(..., { head: true })
// .eq().is() resolving to { count }) and the GET list. Nothing is inserted
// through the session client any more: the key row is minted by the RPC.
function setupFrom(opts: { count?: number | null; listResult?: { data?: unknown; error?: unknown } }) {
  mockSupabase.from.mockImplementation(() => {
    const result = () =>
      Promise.resolve({
        count: opts.count ?? 0,
        data: opts.listResult?.data ?? null,
        error: opts.listResult?.error ?? null,
      })

    const chain: Record<string, unknown> = {}
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result() as unknown)
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => result()
        }
        return () => new Proxy(chain, handler)
      },
    }
    return new Proxy(chain, handler)
  })
}

/**
 * Service-role client stub: records every insert/update/select per table and
 * resolves each chain with the programmed result for that table.
 */
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
  const find = (table: string, method: string) =>
    calls.find((c) => c.table === table && c.method === method)?.args
  return { calls, find }
}

const storedRow = {
  id: 'ak-1',
  key_prefix: 'gnubok_sk_abcd',
  name: 'k',
  scopes: ['reports:read'],
  mode: 'live',
  created_at: '2026-06-05T10:00:00Z',
}

/**
 * Programs a successful create: the quota count, the RPC answer (the new key
 * id) and the read-back row the response is built from.
 */
function setupCreate(opts: { count?: number | null; keyId?: string; row?: Record<string, unknown> } = {}) {
  setupFrom({ count: opts.count ?? 0 })
  const keyId = opts.keyId ?? storedRow.id
  serviceSupabase.rpc.mockResolvedValue({ data: keyId, error: null })
  return setupServiceFrom({ api_keys: { data: opts.row ?? { ...storedRow, id: keyId } } })
}

/** Named arguments of the create_api_key_with_allowlist call. */
function createArgs(): Record<string, unknown> {
  const call = serviceSupabase.rpc.mock.calls.find((c) => c[0] === 'create_api_key_with_allowlist')
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
  serviceSupabase.rpc.mockResolvedValue({ data: null, error: null })
})

describe('POST /api/settings/api-keys', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['reports:read'] },
      }),
      noParams,
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 for an invalid scope', async () => {
    setupFrom({ count: 0 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['totally:bogus'] },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('API_KEY_SCOPE_INVALID')
    expect(serviceSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 for the reserved OAuth marker name (would fake a Claude connection)', async () => {
    setupFrom({ count: 0 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: ' MCP-klient (OAuth) ', scopes: ['reports:read'] },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { field: string; reason: string } }
    }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({ field: 'name', reason: 'reserved' })
    expect(serviceSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 409 API_KEY_SOD_CONFLICT for stage+approve without acknowledgement', async () => {
    setupFrom({ count: 0 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: {
          name: 'k',
          scopes: ['invoices:write', 'pending_operations:approve'],
        },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { conflicting_scope: string; approve_scope: string } }
    }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('API_KEY_SOD_CONFLICT')
    expect(body.error.details.conflicting_scope).toBe('invoices:write')
    expect(body.error.details.approve_scope).toBe('pending_operations:approve')
    expect(serviceSupabase.rpc).not.toHaveBeenCalled()
  })

  it('records sod_acknowledged_at/by in the create when acknowledge_sod is true', async () => {
    setupCreate({
      row: { ...storedRow, scopes: ['invoices:write', 'pending_operations:approve'] },
    })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: {
          name: 'k',
          scopes: ['invoices:write', 'pending_operations:approve'],
          acknowledge_sod: true,
        },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { key: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.key).toMatch(/^gnubok_sk_/)

    expect(serviceSupabase.rpc).toHaveBeenCalledTimes(1)
    const payload = createArgs()
    expect(payload.p_sod_acknowledged_by).toBe('user-1')
    expect(typeof payload.p_sod_acknowledged_at).toBe('string')
    // ISO timestamp
    expect(payload.p_sod_acknowledged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('creates a clean key without approve scope and does not set SoD fields', async () => {
    const service = setupCreate({ keyId: 'ak-2', row: { ...storedRow, id: 'ak-2', name: 'reader' } })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'reader', scopes: ['reports:read'] },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{
      data: { id: string; key: string; created_at: string; company_ids: string[] | null }
    }>(res)
    expect(status).toBe(200)
    // No allowlist requested: unrestricted, and the allowlist table is never touched.
    expect(body.data.company_ids).toBeNull()
    expect(service.calls.some((c) => c.table === 'api_key_companies')).toBe(false)
    // The response is the stored row plus the one-time key.
    expect(body.data.id).toBe('ak-2')
    expect(body.data.created_at).toBe('2026-06-05T10:00:00Z')
    expect(body.data.key).toMatch(/^gnubok_sk_/)

    const payload = createArgs()
    expect(payload.p_sod_acknowledged_at).toBeNull()
    expect(payload.p_sod_acknowledged_by).toBeNull()
    expect(payload.p_scopes).toEqual(['reports:read'])
    expect(payload.p_user_id).toBe('user-1')
    expect(payload.p_name).toBe('reader')
    // Default mode is live, bound to the active company, unrestricted.
    expect(payload.p_mode).toBe('live')
    expect(payload.p_company_id).toBe('company-1')
    expect(payload.p_company_ids).toBeNull()
    // Hand-minted keys carry no OAuth client or refresh token.
    expect(payload.p_client).toBeNull()
    expect(payload.p_refresh_token_hash).toBeNull()
    expect(payload.p_unattended_commit_limit).toBeNull()
    // The stored hash is what the RPC received, and the key it returned matches it.
    expect(typeof payload.p_key_hash).toBe('string')
    expect(body.data.key.startsWith(payload.p_key_prefix as string)).toBe(true)
  })

  it('creates a test key bound to the active company with mode=test', async () => {
    setupCreate({ keyId: 'ak-3', row: { ...storedRow, id: 'ak-3', key_prefix: 'gnubok_sk_test_abc', name: 'pilot', mode: 'test' } })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'pilot', scopes: ['reports:read'], mode: 'test' },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { key: string } }>(res)
    expect(status).toBe(200)
    // Real generateApiKey('test') runs: the returned secret carries the infix.
    expect(body.data.key).toMatch(/^gnubok_sk_test_/)

    const payload = createArgs()
    expect(payload.p_mode).toBe('test')
    // Test keys are simulation-only: they bind to the active company (the v1
    // wrapper forces dry-run so they never persist).
    expect(payload.p_company_id).toBe('company-1')
  })

  it('returns API_KEY_QUOTA_EXCEEDED before minting when 10 keys are live', async () => {
    setupCreate({ count: 10 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['reports:read'] },
      }),
      noParams,
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('API_KEY_QUOTA_EXCEEDED')
    expect(serviceSupabase.rpc).not.toHaveBeenCalled()
  })

  it('answers 500 API_KEY_CREATE_FAILED and hands out no key when the RPC fails', async () => {
    // One transaction: a failure means neither the key row nor the allowlist
    // rows exist, so there is nothing to revoke and no key to return.
    setupFrom({ count: 0 })
    serviceSupabase.rpc.mockResolvedValue({ data: null, error: { message: 'fk violation', code: '23503' } })
    const service = setupServiceFrom()
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['reports:read'] },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string }; data?: unknown }>(res)
    expect(status).toBe(500)
    expect(body.error.code).toBe('API_KEY_CREATE_FAILED')
    expect(body.data).toBeUndefined()
    expect(service.calls).toEqual([])
  })

  it('answers 500 and hands out no key when the RPC returns no id', async () => {
    setupFrom({ count: 0 })
    serviceSupabase.rpc.mockResolvedValue({ data: null, error: null })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['reports:read'] },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string }; data?: unknown }>(res)
    expect(status).toBe(500)
    expect(body.error.code).toBe('API_KEY_CREATE_FAILED')
    expect(body.data).toBeUndefined()
  })

  it('still returns the key when the read-back after a successful create fails', async () => {
    // The key exists once the RPC returned: losing it here would strand a
    // live key the caller never saw.
    setupFrom({ count: 0 })
    serviceSupabase.rpc.mockResolvedValue({ data: 'ak-8', error: null })
    setupServiceFrom({ api_keys: { error: { message: 'connection reset' } } })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['reports:read'] },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{
      data: { id: string; key: string; name: string; mode: string; created_at: string | null }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.id).toBe('ak-8')
    expect(body.data.key).toMatch(/^gnubok_sk_/)
    expect(body.data.name).toBe('k')
    expect(body.data.mode).toBe('live')
    expect(body.data.created_at).toBeNull()
  })

  describe('admin gate on the key company', () => {
    it('returns 403 admin_required when the caller is only a member of the active company', async () => {
      // The api_keys_insert policy required owner/admin while the row was
      // inserted through the session client; the service-role RPC does not
      // see the caller, so the route keeps that gate.
      listUserCompaniesForPickerMock.mockResolvedValue([{ company_id: 'company-1', name: 'Test AB', role: 'member' }])
      setupCreate()
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'] },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{
        error: { code: string; details: { field: string; reason: string; company_id: string } }
      }>(res)
      expect(status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.details).toEqual({ field: 'company_id', reason: 'admin_required', company_id: 'company-1' })
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns 403 admin_required when the allowlist binds the key to a company the caller only belongs to', async () => {
      getActiveCompanyIdMock.mockResolvedValue(ACTIVE)
      listUserCompaniesForPickerMock.mockResolvedValue(memberships)
      setupCreate()
      // ACTIVE is unticked, so the key would bind to THIRD, where the caller is a member.
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'], company_ids: [THIRD] },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{
        error: { code: string; details: { reason: string; company_id: string } }
      }>(res)
      expect(status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.details).toMatchObject({ reason: 'admin_required', company_id: THIRD })
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns 500 rather than minting when the membership list cannot be read', async () => {
      listUserCompaniesForPickerMock.mockRejectedValue(new Error('connection reset'))
      setupCreate()
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'] },
        }),
        noParams,
      )
      expect(res.status).toBe(500)
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })
  })

  describe('company_ids (per-key company allowlist)', () => {
    beforeEach(() => {
      getActiveCompanyIdMock.mockResolvedValue(ACTIVE)
      listUserCompaniesForPickerMock.mockResolvedValue(memberships)
    })

    it('returns 400 VALIDATION_ERROR for a non-uuid company id and mints nothing', async () => {
      setupCreate()
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'], company_ids: ['not-a-uuid'] },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string; details: { field: string } } }>(res)
      expect(status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details.field).toBe('company_ids')
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns 403 FORBIDDEN when an id is not one of the caller\'s memberships', async () => {
      setupCreate()
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'], company_ids: [ACTIVE, FOREIGN] },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{
        error: { code: string; details: { company_ids: string[] } }
      }>(res)
      expect(status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.details.company_ids).toEqual([FOREIGN])
      expect(serviceSupabase.rpc).not.toHaveBeenCalled()
      expect(serviceSupabase.from).not.toHaveBeenCalled()
    })

    it('passes the strict subset to the RPC and keeps the active company as default', async () => {
      setupCreate({ keyId: 'ak-4' })
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'], company_ids: [THIRD, ACTIVE] },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{ data: { company_ids: string[] | null } }>(res)
      expect(status).toBe(200)
      // Picker order, not submission order.
      expect(body.data.company_ids).toEqual([ACTIVE, THIRD])

      const payload = createArgs()
      expect(payload.p_company_id).toBe(ACTIVE)
      expect(payload.p_company_ids).toEqual([ACTIVE, THIRD])
      // The key row and the allowlist rows are one RPC call, never a
      // separate api_key_companies insert.
      expect(serviceSupabase.from).not.toHaveBeenCalledWith('api_key_companies')
    })

    it('binds the key to the first selected company when the active one is left out', async () => {
      setupCreate({ keyId: 'ak-5' })
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'], company_ids: [THIRD, OTHER] },
        }),
        noParams,
      )
      expect(res.status).toBe(200)
      const payload = createArgs()
      expect(payload.p_company_id).toBe(OTHER)
      expect(payload.p_company_ids).toEqual([OTHER, THIRD])
    })

    it('passes null when every membership is selected (unrestricted key)', async () => {
      setupCreate({ keyId: 'ak-6' })
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'], company_ids: [THIRD, OTHER, ACTIVE] },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{ data: { company_ids: string[] | null } }>(res)
      expect(status).toBe(200)
      expect(body.data.company_ids).toBeNull()
      const payload = createArgs()
      expect(payload.p_company_id).toBe(ACTIVE)
      expect(payload.p_company_ids).toBeNull()
    })

    it('answers 500 and hands out no key when the RPC refuses the allowlist', async () => {
      // The RPC is the backstop: a membership that vanished between the
      // pre-check and the write rolls the whole create back.
      setupFrom({ count: 0 })
      serviceSupabase.rpc.mockResolvedValue({
        data: null,
        error: { message: 'user is not a live member of company', code: '42501' },
      })
      const service = setupServiceFrom()
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'k', scopes: ['reports:read'], company_ids: [ACTIVE] },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string }; data?: unknown }>(res)
      expect(status).toBe(500)
      expect(body.error.code).toBe('API_KEY_CREATE_FAILED')
      expect(body.data).toBeUndefined()
      // Nothing to revoke: the transaction left no key behind.
      expect(service.find('api_keys', 'update')).toBeUndefined()
      expect(service.calls).toEqual([])
    })
  })
})

describe('GET /api/settings/api-keys', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(createMockRequest('/api/settings/api-keys'), noParams)
    expect(res.status).toBe(401)
  })

  it('adds company_ids per key (null = unrestricted) and the picker companies in meta', async () => {
    getActiveCompanyIdMock.mockResolvedValue(ACTIVE)
    listUserCompaniesForPickerMock.mockResolvedValue(memberships)
    setupFrom({
      listResult: {
        data: [
          { id: 'ak-1', key_prefix: 'gnubok_sk_a', name: 'restricted', scopes: ['reports:read'], revoked_at: null, created_at: '2026-06-05T10:00:00Z' },
          { id: 'ak-2', key_prefix: 'gnubok_sk_b', name: 'open', scopes: ['reports:read'], revoked_at: null, created_at: '2026-06-04T10:00:00Z' },
        ],
      },
    })
    const service = setupServiceFrom({
      api_key_companies: {
        data: [
          { api_key_id: 'ak-1', company_id: ACTIVE },
          { api_key_id: 'ak-1', company_id: THIRD },
        ],
      },
    })

    const res = await GET(createMockRequest('/api/settings/api-keys'), noParams)
    const { status, body } = await parseJsonResponse<{
      data: Array<{ id: string; company_ids: string[] | null }>
      meta: { companies: Array<{ company_id: string; name: string; is_active: boolean }> }
    }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual([
      expect.objectContaining({ id: 'ak-1', company_ids: [ACTIVE, THIRD] }),
      expect.objectContaining({ id: 'ak-2', company_ids: null }),
    ])
    expect(body.meta.companies).toEqual([
      { company_id: ACTIVE, name: 'Aktiva AB', is_active: true },
      { company_id: OTHER, name: 'Andra AB', is_active: false },
      { company_id: THIRD, name: 'Tredje AB', is_active: false },
    ])
    // One query for all listed keys, grouped in code.
    expect(service.find('api_key_companies', 'in')).toEqual(['api_key_id', ['ak-1', 'ak-2']])
    expect(listUserCompaniesForPickerMock).toHaveBeenCalledWith(expect.anything(), 'user-1', { activeCompanyId: ACTIVE })
  })

  it('skips the allowlist query when there are no keys', async () => {
    setupFrom({ listResult: { data: [] } })
    const res = await GET(createMockRequest('/api/settings/api-keys'), noParams)
    const { status, body } = await parseJsonResponse<{ data: unknown[]; meta: { companies: unknown[] } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.meta.companies).toHaveLength(1)
    expect(serviceSupabase.from).not.toHaveBeenCalled()
  })
})
