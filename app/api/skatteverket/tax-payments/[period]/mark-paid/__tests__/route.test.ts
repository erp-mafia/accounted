import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST } from '../route'

describe('POST /api/skatteverket/tax-payments/[period]/mark-paid', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/mark-paid', { method: 'POST' }),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/mark-paid', { method: 'POST' }),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(403)
  })

  it('returns 400 for an invalid period', async () => {
    const response = await POST(
      createMockRequest('/api/skatteverket/tax-payments/nope/mark-paid', { method: 'POST' }),
      createMockRouteParams({ period: 'nope' }),
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 when no AGI exists for the period', async () => {
    enqueue({ data: null }) // agi lookup

    const response = await POST(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/mark-paid', { method: 'POST' }),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(404)
  })

  it('marks the AGI period as paid (happy path)', async () => {
    enqueue({ data: { id: 'agi-1' } }) // agi lookup
    enqueue({ data: null, error: null }) // update

    const response = await POST(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/mark-paid', { method: 'POST' }),
      createMockRouteParams({ period: '2026-04' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { ok: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.ok).toBe(true)
  })
})
