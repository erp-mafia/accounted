import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  unlockPeriod: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { unlockPeriod } from '@/lib/core/bookkeeping/period-service'
import { POST } from '../route'

function unlockRequest(): Request {
  return createMockRequest('/api/bookkeeping/fiscal-periods/p1/unlock', { method: 'POST' })
}

function mockAuth() {
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: 'user-1' },
    supabase: {},
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/unlock', () => {
  it('unlocks the period and returns it on success', async () => {
    mockAuth()
    ;(unlockPeriod as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'p1', locked_at: null })
    const res = await POST(unlockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe('p1')
  })

  it('maps a not-locked period to a 409', async () => {
    mockAuth()
    ;(unlockPeriod as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Period is not locked'))
    const res = await POST(unlockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_UNLOCK_NOT_LOCKED')
  })

  it('maps a closed period to a 409', async () => {
    mockAuth()
    ;(unlockPeriod as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Cannot unlock a closed period'),
    )
    const res = await POST(unlockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_UNLOCK_CLOSED')
  })

  it('maps a missing period to a 404', async () => {
    mockAuth()
    ;(unlockPeriod as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Fiscal period not found'))
    const res = await POST(unlockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })
})
