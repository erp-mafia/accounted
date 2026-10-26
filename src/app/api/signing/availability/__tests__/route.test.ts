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
vi.mock('@/lib/signing/requests', () => ({ signingAvailable: () => availableMock() }))

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

  it('answers true when signing is open here', async () => {
    availableMock.mockResolvedValue(true)
    const response = await GET(createMockRequest('/api/signing/availability'), createMockRouteParams({}))
    expect(await parseJsonResponse(response)).toEqual({ status: 200, body: { data: { available: true } } })
  })

  it('answers false when the switch is off or no provider is wired', async () => {
    availableMock.mockResolvedValue(false)
    const response = await GET(createMockRequest('/api/signing/availability'), createMockRouteParams({}))
    expect(await parseJsonResponse(response)).toEqual({ status: 200, body: { data: { available: false } } })
  })
})
