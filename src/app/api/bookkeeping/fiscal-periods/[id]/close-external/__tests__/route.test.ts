/**
 * Tests for POST /api/bookkeeping/fiscal-periods/[id]/close-external
 * ("klarmarkera": period closed in a previous bookkeeping system).
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
  markPeriodClosedExternally: vi.fn(),
}))

import { markPeriodClosedExternally } from '@/lib/core/bookkeeping/period-service'
import { POST } from '../route'

const mockMark = vi.mocked(markPeriodClosedExternally)
const idParams = { params: Promise.resolve({ id: 'period-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/close-external', () => {
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
    expect(mockMark).not.toHaveBeenCalled()
  })

  // The refusal answers a registry code in the canonical envelope (it used
  // to be a bare { error: string } 400 for every refusal).
  it('maps a service refusal to its registry code', async () => {
    mockMark.mockRejectedValue(new Error('Period is already closed'))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams)
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('FISCAL_PERIOD_CLOSE_EXTERNAL_ALREADY_CLOSED')
    expect(body.error.message.length).toBeGreaterThan(0)
  })

  it('passes the Swedish unbooked-transactions sentence through', async () => {
    mockMark.mockRejectedValue(
      new Error('Kan inte klarmarkera period: 2 banktransaktion(er) i perioden saknar bokföring (2 ej hanterade).')
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams)
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('PERIOD_HAS_UNBOOKED_TRANSACTIONS')
    expect(body.error.message).toMatch(/2 banktransaktion\(er\)/)
  })

  it('marks the period on the happy path', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockMark.mockResolvedValue({ id: 'period-1', is_closed: true, closed_externally: true } as any)
    const { status, body } = await parseJsonResponse<{
      data: { is_closed: boolean; closed_externally: boolean }
    }>(await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams))
    expect(status).toBe(200)
    expect(body.data.is_closed).toBe(true)
    expect(body.data.closed_externally).toBe(true)
    expect(mockMark).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'period-1')
  })
})
