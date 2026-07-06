/**
 * Tests for POST /api/bookkeeping/fiscal-periods/[id]/close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

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

vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  closePeriod: vi.fn(),
}))

import { closePeriod } from '@/lib/core/bookkeeping/period-service'
import { POST } from '../route'

const mockClosePeriod = vi.mocked(closePeriod)
const idParams = { params: Promise.resolve({ id: 'period-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/close', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams)
    expect(res.status).toBe(401)
  })

  it('returns 403 when the caller lacks write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams)
    expect(res.status).toBe(403)
    expect(mockClosePeriod).not.toHaveBeenCalled()
  })

  it('maps a service refusal to 400 with the message', async () => {
    mockClosePeriod.mockRejectedValue(new Error('Period contains draft entries'))
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams)
    )
    expect(status).toBe(400)
    expect(body.error).toBe('Period contains draft entries')
  })

  it('closes the period on the happy path', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockClosePeriod.mockResolvedValue({ id: 'period-1', is_closed: true } as any)
    const { status, body } = await parseJsonResponse<{ data: { is_closed: boolean } }>(
      await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams)
    )
    expect(status).toBe(200)
    expect(body.data.is_closed).toBe(true)
    expect(mockClosePeriod).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'period-1')
  })
})
