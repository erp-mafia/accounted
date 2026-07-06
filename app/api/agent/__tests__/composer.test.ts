/**
 * Tests for POST /api/agent/composer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const checkRateMock = vi.fn()
vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: (...args: unknown[]) => checkRateMock(...args),
  agentRateLimitResponseBody: () => ({ error: 'För många förfrågningar.' }),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/entitlements/keys', () => ({
  CAPABILITY: { ai: 'ai' },
}))

const composeMock = vi.fn()
vi.mock('@/lib/agent/composer', () => ({
  composeAgentProfile: (...args: unknown[]) => composeMock(...args),
}))

import { POST } from '../composer/route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  checkRateMock.mockResolvedValue({ ok: true })
})

describe('POST /api/agent/composer', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const req = createMockRequest('/api/agent/composer', { method: 'POST', body: {} })
    const res = await POST(req, routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 429 when rate limited', async () => {
    checkRateMock.mockResolvedValue({ ok: false, retryAfterSec: 30 })

    const req = createMockRequest('/api/agent/composer', { method: 'POST', body: {} })
    const res = await POST(req, routeParams)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
  })

  it('refuses a viewer with 403 (composer rewrites the profile)', async () => {
    enqueue({ data: { role: 'viewer' } })

    const req = createMockRequest('/api/agent/composer', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(req, routeParams)
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('WRITE_PERMISSION_REQUIRED')
    expect(composeMock).not.toHaveBeenCalled()
  })

  it('runs the composer for a non-viewer member', async () => {
    enqueue({ data: { role: 'owner' } })
    composeMock.mockResolvedValue({ company_id: 'company-1', profile_summary: 'Byggd' })

    const req = createMockRequest('/api/agent/composer', {
      method: 'POST',
      body: { dry_run: true },
    })
    const { status, body } = await parseJsonResponse<{ data: { profile_summary: string } }>(
      await POST(req, routeParams)
    )
    expect(status).toBe(200)
    expect(body.data.profile_summary).toBe('Byggd')
    expect(composeMock).toHaveBeenCalledWith(expect.anything(), 'company-1', { dryRun: true })
  })
})
