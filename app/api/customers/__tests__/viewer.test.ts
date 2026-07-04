/**
 * Representative viewer-403 test.
 *
 * Verifies that POST /api/customers returns 403 when the caller's
 * requireWritePermission check returns an error response. This is a
 * canary test: if it breaks, the wiring between mutating routes and
 * requireWritePermission has drifted.
 *
 * The full per-role behavior of requireWritePermission itself is
 * covered in lib/auth/__tests__/require-write.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockAuthGetUser = vi.fn()
const mockFrom = vi.fn()
const mockSupabase = {
  auth: { getUser: mockAuthGetUser },
  from: mockFrom,
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

import { POST } from '../route'

describe('POST /api/customers: viewer role gate', () => {
  const mockUser = { id: 'user-1', email: 'viewer@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthGetUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 403 with Swedish message when requireWritePermission rejects', async () => {
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })

    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Test customer', customer_type: 'company' },
    })

    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toContain('läsbehörighet')
  })

  it('calls requireWritePermission with the authenticated user id', async () => {
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'blocked' }, { status: 403 }),
    })

    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Test customer', customer_type: 'company' },
    })

    await POST(request)

    expect(requireWritePermissionMock).toHaveBeenCalledWith(mockSupabase, 'user-1')
  })
})
