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

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

// Records the payload passed to .insert(), and lets us program the count
// returned by the quota pre-check and the row returned by the insert.
function setupFrom(opts: {
  count?: number | null
  insertResult?: { data?: unknown; error?: unknown }
}) {
  const insertSpy = vi.fn()

  mockSupabase.from.mockImplementation(() => {
    // The quota pre-check: .select(..., { head: true }).eq().is() → resolves
    // to { count }. The insert: .insert().select().single() → resolves to the
    // row. We expose both via a single chainable proxy whose terminal value
    // depends on whether insert() was called.
    let isInsert = false
    const result = () =>
      isInsert
        ? Promise.resolve({
            data: opts.insertResult?.data ?? null,
            error: opts.insertResult?.error ?? null,
          })
        : Promise.resolve({ count: opts.count ?? 0, data: null, error: null })

    const chain: Record<string, unknown> = {}
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result() as unknown)
        }
        if (prop === 'insert') {
          return (payload: unknown) => {
            isInsert = true
            insertSpy(payload)
            return new Proxy(chain, handler)
          }
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => result()
        }
        return () => new Proxy(chain, handler)
      },
    }
    return new Proxy(chain, handler)
  })

  return { insertSpy }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  getActiveCompanyIdMock.mockResolvedValue('company-1')
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('POST /api/settings/api-keys', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['reports:read'] },
      }),
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
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('API_KEY_SCOPE_INVALID')
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
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { conflicting_scope: string; approve_scope: string } }
    }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('API_KEY_SOD_CONFLICT')
    expect(body.error.details.conflicting_scope).toBe('invoices:write')
    expect(body.error.details.approve_scope).toBe('pending_operations:approve')
  })

  it('records sod_acknowledged_at/by in the insert when acknowledge_sod is true', async () => {
    const { insertSpy } = setupFrom({
      count: 0,
      insertResult: {
        data: {
          id: 'ak-1',
          key_prefix: 'gnubok_sk_abcd',
          name: 'k',
          scopes: ['invoices:write', 'pending_operations:approve'],
          created_at: '2026-06-05T10:00:00Z',
        },
      },
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
    )
    const { status, body } = await parseJsonResponse<{ data: { key: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.key).toMatch(/^gnubok_sk_/)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.sod_acknowledged_by).toBe('user-1')
    expect(typeof payload.sod_acknowledged_at).toBe('string')
    // ISO timestamp
    expect(payload.sod_acknowledged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('creates a clean key without approve scope and does not set SoD fields', async () => {
    const { insertSpy } = setupFrom({
      count: 0,
      insertResult: {
        data: {
          id: 'ak-2',
          key_prefix: 'gnubok_sk_efgh',
          name: 'reader',
          scopes: ['reports:read'],
          created_at: '2026-06-05T10:00:00Z',
        },
      },
    })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'reader', scopes: ['reports:read'] },
      }),
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)

    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('sod_acknowledged_at')
    expect(payload).not.toHaveProperty('sod_acknowledged_by')
    expect(payload.scopes).toEqual(['reports:read'])
  })
})
