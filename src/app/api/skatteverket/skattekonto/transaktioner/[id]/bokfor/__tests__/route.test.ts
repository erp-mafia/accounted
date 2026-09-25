import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

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

const bokforMock = vi.fn()
vi.mock('@/lib/skatteverket/skattekonto-booking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skatteverket/skattekonto-booking')>()
  return { ...actual, bokforSkattekontoTransaction: (...a: unknown[]) => bokforMock(...a) }
})

import { POST } from '../route'
import { SkattekontoBookingError } from '@/lib/skatteverket/skattekonto-booking'

const ID = '10df7147-ee68-4c9e-b989-06485adf1f62'
const call = () => POST(createMockRequest(`/api/skatteverket/skattekonto/transaktioner/${ID}/bokfor`, { method: 'POST' }), createMockRouteParams({ id: ID }))

describe('POST /api/skatteverket/skattekonto/transaktioner/[id]/bokfor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' },
      supabase: mockSupabase,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await call())
    expect(status).toBe(401)
  })

  // The whole point: a row imported from a file must be bookable on an
  // installation where the Skatteverket integration is switched off, which is
  // exactly where the extension route answered 503.
  it('books the row and returns the entry', async () => {
    bokforMock.mockResolvedValue({ id: 'entry-1', voucher_number: 12 })
    const { status, body } = await parseJsonResponse<{ data: { entry: { id: string } } }>(await call())

    expect(status).toBe(200)
    expect(body.data.entry.id).toBe('entry-1')
    expect(bokforMock).toHaveBeenCalledWith(mockSupabase, 'company-1', 'user-1', ID)
  })

  it('maps the booking refusals onto their own statuses', async () => {
    for (const [code, expected] of [
      ['TRANSACTION_NOT_FOUND', 404],
      ['ALREADY_BOOKED', 409],
      ['PERIOD_LOCKED', 423],
      ['NO_COUNTER_ACCOUNT', 422],
    ] as const) {
      bokforMock.mockRejectedValue(new SkattekontoBookingError('Raden är redan bokförd.', code))
      const { status, body } = await parseJsonResponse<{ code?: string }>(await call())
      expect(status).toBe(expected)
      expect(body.code).toBe(code)
    }
  })

  it('rejects an id that is not a uuid', async () => {
    const res = await POST(
      createMockRequest('/api/skatteverket/skattekonto/transaktioner/not-a-uuid/bokfor', { method: 'POST' }),
      createMockRouteParams({ id: 'not-a-uuid' }),
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })
})
