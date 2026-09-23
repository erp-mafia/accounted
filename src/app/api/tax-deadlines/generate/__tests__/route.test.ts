import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const mocks = vi.hoisted(() => ({
  regenerate: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/tax/deadline-generator', () => ({
  DEADLINE_SETTINGS_SELECT: 'company_id, entity_type',
  regenerateTaxDeadlinesForUser: mocks.regenerate,
  toDeadlineSettings: vi.fn((settings: Record<string, unknown>) => settings),
}))

import { POST } from '../route'

function request(): Request {
  return createMockRequest('/api/tax-deadlines/generate', { method: 'POST' })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  mocks.regenerate.mockResolvedValue({ created: 12, deleted: 0 })
})

describe('POST /api/tax-deadlines/generate', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(request(), { params: Promise.resolve({}) })

    expect(response.status).toBe(401)
    expect(mocks.regenerate).not.toHaveBeenCalled()
  })

  it('returns 403 without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(request(), { params: Promise.resolve({}) })

    expect(response.status).toBe(403)
    expect(mocks.regenerate).not.toHaveBeenCalled()
  })

  it('returns 404 when company settings are missing', async () => {
    enqueue({ data: null, error: { code: 'PGRST116', message: 'No rows returned' } })

    const response = await POST(request(), { params: Promise.resolve({}) })

    expect(response.status).toBe(404)
  })

  it('regenerates the current company deadlines', async () => {
    enqueue({ data: { company_id: 'company-1', entity_type: 'aktiebolag' } })

    const response = await POST(request(), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      success: boolean
      created: number
      deleted: number
    }>(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, created: 12, deleted: 0 })
    expect(mocks.regenerate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ entity_type: 'aktiebolag' }),
    )
  })

  it('returns 500 when generation fails', async () => {
    enqueue({ data: { company_id: 'company-1', entity_type: 'aktiebolag' } })
    mocks.regenerate.mockRejectedValueOnce(new Error('insert failed'))

    const response = await POST(request(), { params: Promise.resolve({}) })

    expect(response.status).toBe(500)
  })
})
