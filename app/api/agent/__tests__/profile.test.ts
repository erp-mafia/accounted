/**
 * Tests for GET/PATCH /api/agent/profile and POST /api/agent/profile/verify.
 *
 * Covers the role model: reads allow any member, mutations (PATCH, verify)
 * refuse viewers — the same rule verify always had, now enforced on PATCH too.
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

import { GET, PATCH } from '../profile/route'
import { POST as VERIFY } from '../profile/verify/route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/agent/profile', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/agent/profile'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 403 when the caller is not a member of the target company', async () => {
    enqueue({ data: null }) // membership lookup

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/agent/profile'), routeParams)
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('NOT_COMPANY_MEMBER')
  })

  it('returns the profile for a member (viewers may read)', async () => {
    enqueue({ data: { role: 'viewer' } })
    enqueue({ data: { company_id: 'company-1', profile_summary: 'Konsultbolag' } })

    const { status, body } = await parseJsonResponse<{ data: { profile_summary: string } }>(
      await GET(createMockRequest('/api/agent/profile'), routeParams)
    )
    expect(status).toBe(200)
    expect(body.data.profile_summary).toBe('Konsultbolag')
  })
})

describe('PATCH /api/agent/profile', () => {
  it('refuses a viewer with 403 (profile mutation)', async () => {
    enqueue({ data: { role: 'viewer' } })

    const req = createMockRequest('/api/agent/profile', {
      method: 'PATCH',
      body: { profile_summary: 'Nytt sammandrag' },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, routeParams)
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('WRITE_PERMISSION_REQUIRED')
  })

  it('returns 404 when the company has no agent_profile row', async () => {
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: null }) // current profile lookup

    const req = createMockRequest('/api/agent/profile', {
      method: 'PATCH',
      body: { profile_summary: 'Nytt sammandrag' },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, routeParams)
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('AGENT_PROFILE_NOT_FOUND')
  })

  it('returns 400 when the body contains nothing to update', async () => {
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: { field_overrides: null } })

    const req = createMockRequest('/api/agent/profile', { method: 'PATCH', body: {} })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, routeParams)
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('NOTHING_TO_UPDATE')
  })

  it('merges field_overrides and updates the profile', async () => {
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: { field_overrides: { old: { value: 1, overridden_at: 'x' } } } })
    enqueue({ data: { company_id: 'company-1', profile_summary: 'Uppdaterad' } })

    const req = createMockRequest('/api/agent/profile', {
      method: 'PATCH',
      body: { profile_summary: 'Uppdaterad', field_overrides: { vat_period: 'quarterly' } },
    })
    const { status, body } = await parseJsonResponse<{ data: { profile_summary: string } }>(
      await PATCH(req, routeParams)
    )
    expect(status).toBe(200)
    expect(body.data.profile_summary).toBe('Uppdaterad')
  })
})

describe('POST /api/agent/profile/verify', () => {
  it('refuses a viewer with 403', async () => {
    enqueue({ data: { role: 'viewer' } })

    const req = createMockRequest('/api/agent/profile/verify', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await VERIFY(req, routeParams)
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('WRITE_PERMISSION_REQUIRED')
  })

  it('stamps verified_at for a non-viewer member', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { company_id: 'company-1', verified_at: '2026-07-03T00:00:00Z', verified_by_user_id: 'user-1' } })

    const req = createMockRequest('/api/agent/profile/verify', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ data: { verified_by_user_id: string } }>(
      await VERIFY(req, routeParams)
    )
    expect(status).toBe(200)
    expect(body.data.verified_by_user_id).toBe('user-1')
  })
})
