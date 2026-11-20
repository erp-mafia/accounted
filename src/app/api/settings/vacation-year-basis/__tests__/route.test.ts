import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, calls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const URL = '/api/settings/vacation-year-basis'

describe('GET /api/settings/vacation-year-basis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest(URL), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
  })

  it('offers the choice while no vacation balances are open', async () => {
    enqueue({ data: null, count: 0 })
    const response = await GET(createMockRequest(URL), { params: Promise.resolve({}) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { changeable: true, reason: null } })
    const balances = calls.find((c) => c.table === 'employee_vacation_balances')
    expect(balances).toBeDefined()
  })

  it('locks it with the settings service refusal while open balances exist', async () => {
    enqueue({ data: null, count: 3 })
    const response = await GET(createMockRequest(URL), { params: Promise.resolve({}) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { changeable: false, reason: 'SETTINGS_VACATION_BASIS_OPEN_BALANCES' },
    })
  })

  it('fails with an error, never a choice, when the check cannot be read', async () => {
    enqueue({ data: null, error: { message: 'boom', code: '57014' } })
    const response = await GET(createMockRequest(URL), { params: Promise.resolve({}) })
    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
