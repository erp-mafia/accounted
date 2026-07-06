/**
 * Tests for /api/company/current — GET (cross-tab sync) and PATCH (K2/K3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { GET, PATCH } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  getActiveCompanyIdMock.mockResolvedValue('company-1')
})

describe('GET /api/company/current', () => {
  it('returns 401 with no-store when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET()
    expect(res.status).toBe(401)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns null companyId when the user has no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    const { status, body } = await parseJsonResponse<{ companyId: string | null }>(await GET())
    expect(status).toBe(200)
    expect(body.companyId).toBeNull()
  })
})

describe('PATCH /api/company/current', () => {
  it('rejects K3 for enskild firma with 400', async () => {
    enqueue({ data: { entity_type: 'enskild_firma' } })

    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { accounting_framework: 'k3' },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await PATCH(req, routeParams)
    )
    expect(status).toBe(400)
    expect(body.error).toContain('aktiebolag')
  })

  it('updates the framework for an aktiebolag', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // entity check
    enqueue({ data: { id: 'company-1', accounting_framework: 'k3', entity_type: 'aktiebolag' } }) // update
    enqueue({ data: null }) // K3 latent-tax account upsert

    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { accounting_framework: 'k3' },
    })
    const { status, body } = await parseJsonResponse<{
      data: { accounting_framework: string }
    }>(await PATCH(req, routeParams))

    expect(status).toBe(200)
    expect(body.data.accounting_framework).toBe('k3')
  })
})
