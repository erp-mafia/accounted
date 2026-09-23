import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

// mergeWithDefaults is exercised for real; it just fills defaults on the input.
import { GET, PUT } from '../route'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
})

describe('GET /api/kpi/preferences', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/kpi/preferences'), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns merged preferences', async () => {
    enqueue({ data: { value: {} } })
    const res = await GET(createMockRequest('/api/kpi/preferences'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toBeDefined()
  })
})

describe('PUT /api/kpi/preferences', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const req = createMockRequest('/api/kpi/preferences', { method: 'PUT', body: {} })
    const res = await PUT(req, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 403 when caller has read-only role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    const req = createMockRequest('/api/kpi/preferences', { method: 'PUT', body: {} })
    const res = await PUT(req, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('rejects an account override that is not a 4-digit string', async () => {
    const req = createMockRequest('/api/kpi/preferences', {
      method: 'PUT',
      body: { accountOverrides: { some_kpi: ['abc'] } },
    })
    const res = await PUT(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toContain('4 digits')
  })

  it('upserts and returns the stored value on the happy path', async () => {
    enqueue({ data: { value: {} } }) // existing row lookup
    enqueue({ data: { value: { accountOverrides: { some_kpi: ['3001'] } } } }) // upsert
    const req = createMockRequest('/api/kpi/preferences', {
      method: 'PUT',
      body: { accountOverrides: { some_kpi: ['3001'] } },
    })
    const res = await PUT(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { accountOverrides: Record<string, string[]> } }>(res)
    expect(status).toBe(200)
    expect(body.data.accountOverrides.some_kpi).toEqual(['3001'])
  })

  it('rejects an accountOverrides value that is not an array of strings', async () => {
    const req = createMockRequest('/api/kpi/preferences', {
      method: 'PUT',
      body: { accountOverrides: { some_kpi: 'not-an-array' } },
    })
    const res = await PUT(req, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

})

/**
 * A partial save used to reset every unmentioned setting: mergeWithDefaults()
 * fills absent keys with FACTORY defaults, and the merged document was what got
 * stored, so saving an account override wiped the user's visible-KPI selection
 * and ordering. The merge base is now the STORED row. Asserted on the payload
 * handed to upsert(); the shared queued mock proxies every chain method, so the
 * payload is captured with a purpose-built recorder.
 */
describe('PUT /api/kpi/preferences merge semantics', () => {
  function createCapturingSupabase(results: { data?: unknown; error?: unknown }[]) {
    const upsertPayloads: Record<string, unknown>[] = []
    const upsertOptions: ({ onConflict?: string } | undefined)[] = []
    let idx = 0
    const makeBuilder = () => {
      const result = results[idx++] ?? { data: null, error: null }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      for (const m of ['select', 'eq', 'maybeSingle', 'single']) {
        b[m] = () => b
      }
      b.upsert = (payload: Record<string, unknown>, options?: { onConflict?: string }) => {
        upsertPayloads.push(payload)
        upsertOptions.push(options)
        return b
      }
      b.then = (resolve: (v: unknown) => void) =>
        resolve({ data: result.data ?? null, error: result.error ?? null })
      return b
    }
    return { supabase: { from: () => makeBuilder() }, upsertPayloads, upsertOptions }
  }

  const stored = {
    visibleKpis: ['kpi_a'],
    kpiOrder: ['kpi_a', 'kpi_b'],
    accountOverrides: { kpi_a: ['3001'] },
  }

  async function put(body: unknown, existing: unknown) {
    const { supabase, upsertPayloads, upsertOptions } = createCapturingSupabase([
      { data: existing === undefined ? null : { value: existing } },
      { data: { value: 'ok' } },
    ])
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase, error: null })
    const res = await PUT(
      createMockRequest('/api/kpi/preferences', { method: 'PUT', body }),
      { params: Promise.resolve({}) },
    )
    return {
      res,
      value: upsertPayloads[0]?.value as Record<string, unknown> | undefined,
      payload: upsertPayloads[0],
      options: upsertOptions[0],
    }
  }

  it('keeps the stored visibleKpis and kpiOrder when only accountOverrides is sent', async () => {
    const { res, value } = await put({ accountOverrides: { kpi_b: ['4010'] } }, stored)
    expect(res.status).toBe(200)
    expect(value).toEqual({
      visibleKpis: ['kpi_a'],
      kpiOrder: ['kpi_a', 'kpi_b'],
      accountOverrides: { kpi_b: ['4010'] },
      showMonthlyTable: true,
    })
  })

  it('replaces every key when the dialog sends the complete object', async () => {
    const full = {
      visibleKpis: ['kpi_z'],
      kpiOrder: ['kpi_z'],
      accountOverrides: { kpi_z: ['3010'] },
      showMonthlyTable: false,
    }
    const { value } = await put(full, stored)
    expect(value).toEqual(full)
  })

  it('falls back to defaults for a row that has never been written', async () => {
    const { res, value } = await put({ visibleKpis: ['kpi_new'] }, undefined)
    expect(res.status).toBe(200)
    expect(value?.visibleKpis).toEqual(['kpi_new'])
    // The other two keys come from the defaults, not from undefined.
    expect(value?.kpiOrder).toBeDefined()
    expect(value?.accountOverrides).toBeDefined()
  })

  it('an empty body stores the stored value unchanged', async () => {
    const { value } = await put({}, stored)
    expect(value).toEqual({ ...stored, showMonthlyTable: true })
  })

  it('stores showMonthlyTable false and leaves the other keys alone', async () => {
    const { res, value } = await put({ showMonthlyTable: false }, stored)
    expect(res.status).toBe(200)
    expect(value).toEqual({ ...stored, showMonthlyTable: false })
  })

  it('rejects a non-boolean showMonthlyTable', async () => {
    const { res } = await put({ showMonthlyTable: 'yes' }, stored)
    expect(res.status).toBe(400)
  })

  it('upserts against the company-scoped unique constraint', async () => {
    // Migration 20260330130000 dropped UNIQUE (user_id, extension_id, key) in
    // favor of UNIQUE (company_id, extension_id, key). Naming the old trio in
    // onConflict makes Postgres reject every save with 42P10, because the
    // surviving user_id index is non-unique and cannot arbitrate ON CONFLICT.
    const { res, payload, options } = await put({ visibleKpis: ['kpi_a'] }, stored)
    expect(res.status).toBe(200)
    expect(options?.onConflict).toBe('company_id,extension_id,key')
    // The row still carries company scoping + last-writer attribution.
    expect(payload).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      extension_id: 'core/kpi',
      key: 'preferences',
    })
  })
})
