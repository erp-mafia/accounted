import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const mockVerifyIntegrity = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  verifyIntegrity: (...args: unknown[]) => mockVerifyIntegrity(...args),
}))

import { POST } from '../route'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeReq() {
  return new Request('http://localhost/api/documents/doc-1/verify', { method: 'POST' })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
})

describe('POST /api/documents/[id]/verify', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 403 when caller has read-only role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
    expect(mockVerifyIntegrity).not.toHaveBeenCalled()
  })

  it('returns the integrity result on success', async () => {
    mockVerifyIntegrity.mockResolvedValue({ verified: true, hash_matches: true })
    const res = await POST(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ data: { verified: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.verified).toBe(true)
    expect(mockVerifyIntegrity).toHaveBeenCalledWith(mockSupabase, 'company-1', 'doc-1')
  })
})
