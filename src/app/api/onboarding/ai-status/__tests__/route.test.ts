import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/api-keys', () => ({ OAUTH_MCP_KEY_NAME: 'MCP OAuth' }))

const CTX = { params: Promise.resolve({}) }
import { GET } from '../route'

describe('GET /api/onboarding/ai-status', () => {
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
    const response = await GET(createMockRequest('/api/onboarding/ai-status'), CTX)
    expect(response.status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns the connected clients from one api_keys read scoped to the caller', async () => {
    enqueue({ data: [{ client: 'claude' }, { client: null }, { client: 'cursor' }], error: null })
    const { status, body } = await parseJsonResponse<{ data: { connected: string[] } }>(
      await GET(createMockRequest('/api/onboarding/ai-status'), CTX),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ connected: ['claude'] })
    // No ledger, no findings: the poll costs exactly this one read.
    expect(supabase.from.mock.calls).toEqual([['api_keys']])
    expect(findCalls('api_keys', 'eq')).toContainEqual(['user_id', 'user-1'])
    expect(findCalls('api_keys', 'is')).toContainEqual(['revoked_at', null])
  })

  it('answers 500, not an empty list, when the read fails', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    const response = await GET(createMockRequest('/api/onboarding/ai-status'), CTX)
    expect(response.status).toBe(500)
  })
})
