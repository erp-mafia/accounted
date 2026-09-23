import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const loadMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/onboarding/findings', () => ({
  loadBooksFindings: (...args: unknown[]) => loadMock(...args),
}))

const CTX = { params: Promise.resolve({}) }
import { GET } from '../route'

describe('GET /api/onboarding/findings', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  })

  it('returns 401 when the user is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest('/api/onboarding/findings'), CTX)
    expect(response.status).toBe(401)
  })

  it('returns the findings for the active company', async () => {
    const findings = { books: { entries: 12 }, bank: { connected: false }, skv: { connected: false } }
    loadMock.mockResolvedValue(findings)
    const { status, body } = await parseJsonResponse<{ data: typeof findings }>(
      await GET(createMockRequest('/api/onboarding/findings'), CTX),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual(findings)
    expect(loadMock).toHaveBeenCalledWith(supabase, 'company-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 'user-1')
  })

  it('answers 500 with a reason when the ledger read fails', async () => {
    loadMock.mockRejectedValue(new Error('boom'))
    const response = await GET(createMockRequest('/api/onboarding/findings'), CTX)
    expect(response.status).toBe(500)
  })

  it.each(['2026-09-14T22:30:00Z', '2026-12-14T23:30:00Z'])('uses the Stockholm calendar date at %s', async (now) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    loadMock.mockResolvedValue({})
    await GET(createMockRequest('/api/onboarding/findings'), CTX)
    expect(loadMock.mock.calls[0][2]).toBe(now.startsWith('2026-09') ? '2026-09-15' : '2026-12-15')
  })
})
