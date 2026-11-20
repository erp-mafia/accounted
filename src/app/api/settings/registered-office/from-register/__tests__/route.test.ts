import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const fillMock = vi.fn()
vi.mock('@/lib/company/registered-office', () => ({
  fillRegisteredOfficeFromRegistry: (...args: unknown[]) => fillMock(...args),
}))

import { POST } from '../route'

const params = { params: Promise.resolve({}) }
const request = () =>
  new Request('http://localhost/api/settings/registered-office/from-register', { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
})

describe('POST /api/settings/registered-office/from-register', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await POST(request(), params)).status).toBe(401)
    expect(fillMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a member who is not owner or admin, before the register is asked', async () => {
    enqueue({ data: false }) // user_is_company_admin
    expect((await POST(request(), params)).status).toBe(403)
    expect(fillMock).not.toHaveBeenCalled()
  })

  it('fills the säte of the active company and says so', async () => {
    enqueue({ data: true }) // user_is_company_admin
    fillMock.mockResolvedValue({ status: 'filled', registered_office: 'Göteborg' })
    const res = await POST(request(), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { status: 'filled', registered_office: 'Göteborg' } })
    // The active company's, with a wait shorter than company creation's: the page holds its first paint for it.
    expect(fillMock).toHaveBeenCalledWith(mockSupabase, 'company-1', { deadlineMs: 3_000 })
  })

  it.each([
    [{ status: 'present', registered_office: 'Stockholm' }],
    [{ status: 'not_found' }],
    [{ status: 'not_saved' }],
  ])('answers 200 with the outcome when nothing was stored: %o', async (outcome) => {
    enqueue({ data: true }) // user_is_company_admin
    fillMock.mockResolvedValue(outcome)
    const res = await POST(request(), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: outcome })
  })

  it('answers 500 when the settings could not be read or written', async () => {
    enqueue({ data: true }) // user_is_company_admin
    fillMock.mockRejectedValue(new Error('Failed to store the registered office: write refused'))
    expect((await POST(request(), params)).status).toBe(500)
  })
})
