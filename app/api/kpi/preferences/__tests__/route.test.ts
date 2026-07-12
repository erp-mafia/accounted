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
    enqueue({ data: { value: { accountOverrides: { some_kpi: ['3001'] } } } })
    const req = createMockRequest('/api/kpi/preferences', {
      method: 'PUT',
      body: { accountOverrides: { some_kpi: ['3001'] } },
    })
    const res = await PUT(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { accountOverrides: Record<string, string[]> } }>(res)
    expect(status).toBe(200)
    expect(body.data.accountOverrides.some_kpi).toEqual(['3001'])
  })
})
