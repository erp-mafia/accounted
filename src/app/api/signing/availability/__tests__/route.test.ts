import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase), createServiceClient: () => mockSupabase }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
const availableMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/signing/requests', () => ({ signingAvailability: (...args: unknown[]) => availableMock(...args) }))

import { requireAuth } from '@/lib/auth/require-auth'
import { GET } from '../route'

const user = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: user as never, supabase: mockSupabase as never, error: null })
})

describe('GET /api/signing/availability', () => {
  it('is 401 without a session and asks nothing', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: null as never, supabase: mockSupabase as never, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const response = await GET(createMockRequest('/api/signing/availability'), createMockRouteParams({}))
    expect(response.status).toBe(401)
    expect(availableMock).not.toHaveBeenCalled()
  })

  it('answers what the active company may do, asked for that company', async () => {
    availableMock.mockResolvedValue({ offered: true, available: true, arsredovisning: false })
    const response = await GET(createMockRequest('/api/signing/availability'), createMockRouteParams({}))
    expect(await parseJsonResponse(response)).toEqual({ status: 200, body: { data: { offered: true, available: true, arsredovisning: false } } })
    expect(availableMock).toHaveBeenCalledWith(mockSupabase, 'company-1')
  })

  it('answers all false when signing is not offered to the company', async () => {
    availableMock.mockResolvedValue({ offered: false, available: false, arsredovisning: false })
    const response = await GET(createMockRequest('/api/signing/availability'), createMockRouteParams({}))
    expect(await parseJsonResponse(response)).toEqual({ status: 200, body: { data: { offered: false, available: false, arsredovisning: false } } })
  })
})
