import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const resolveLandingDestinationMock = vi.fn()
vi.mock('@/lib/company/landing-server', () => ({
  resolveLandingDestination: (...args: unknown[]) => resolveLandingDestinationMock(...args),
}))

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('GET /api/clients/landing', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(createMockRequest('/api/clients/landing'))
    expect(res.status).toBe(401)
  })

  it('returns the helper destination, passing the forwarded host and user', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    resolveLandingDestinationMock.mockResolvedValue('/clients')

    const res = await GET(
      createMockRequest('/api/clients/landing', {
        headers: { 'x-forwarded-host': 'app.amnas.se' },
      })
    )
    const { status, body } = await parseJsonResponse<{ data: { destination: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.destination).toBe('/clients')
    // No active-company requirement: byrå staff without a company of their
    // own (the cockpit's primary persona) must still get a destination.
    expect(resolveLandingDestinationMock).toHaveBeenCalledWith(supabase, 'user-1', 'app.amnas.se')
  })
})
