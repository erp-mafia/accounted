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
    enqueue({ data: { entity_type: 'enskild_firma', accounting_framework: 'k2' } })

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

  it('rejects K3 for an ideell förening with 400 (årsbokslut, never K2/K3)', async () => {
    enqueue({ data: { entity_type: 'ideell_forening', accounting_framework: 'k2' } })
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { accounting_framework: 'k3' },
    })
    const { status } = await parseJsonResponse<{ error: string }>(await PATCH(req, routeParams))
    expect(status).toBe(400)
  })

  it('keeps an ekonomisk förening on K2 until its K3 document ships (K3 rejected with 400)', async () => {
    enqueue({ data: { entity_type: 'ekonomisk_forening', accounting_framework: 'k2' } }) // entity check
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { accounting_framework: 'k3' },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(await PATCH(req, routeParams))
    expect(status).toBe(400)
    expect(body.error).toContain('ekonomisk förening')
  })

  it('refuses a legal-form change that would leave K3 on a form that cannot carry it', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k3' } }) // current row
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { entity_type: 'ekonomisk_forening' },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(await PATCH(req, routeParams))
    expect(status).toBe(400)
    expect(body.error).toContain('K2')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('accepts the same change when the request also moves the company to K2', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k3' } }) // current row
    enqueue({ data: { ok: true, changed: true, entity_type: 'ekonomisk_forening', previous_entity_type: 'aktiebolag' } }) // rpc
    enqueue({ data: { id: 'company-1', accounting_framework: 'k2', entity_type: 'ekonomisk_forening' } }) // update
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { entity_type: 'ekonomisk_forening', accounting_framework: 'k2' },
    })
    const { status, body } = await parseJsonResponse<{
      data: { entity_type: string; accounting_framework: string }
    }>(await PATCH(req, routeParams))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ entity_type: 'ekonomisk_forening', accounting_framework: 'k2' })
    expect(supabase.rpc).toHaveBeenCalledWith('correct_company_entity_type', {
      p_company_id: 'company-1',
      p_entity_type: 'ekonomisk_forening',
    })
  })

  it('judges K3 against the form the company is moving to, not the one it leaves', async () => {
    enqueue({ data: { entity_type: 'ekonomisk_forening', accounting_framework: 'k2' } }) // current row
    enqueue({ data: { ok: true, changed: true, entity_type: 'aktiebolag', previous_entity_type: 'ekonomisk_forening' } }) // rpc
    enqueue({ data: { id: 'company-1', accounting_framework: 'k3', entity_type: 'aktiebolag' } }) // update
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { entity_type: 'aktiebolag', accounting_framework: 'k3' },
    })
    const { status, body } = await parseJsonResponse<{
      data: { entity_type: string; accounting_framework: string }
    }>(await PATCH(req, routeParams))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ entity_type: 'aktiebolag', accounting_framework: 'k3' })
  })

  it('corrects the legal form through the owner-only RPC when the books are empty', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } }) // current row
    enqueue({ data: { ok: true, changed: true, entity_type: 'ekonomisk_forening', previous_entity_type: 'aktiebolag' } }) // rpc
    enqueue({ data: { id: 'company-1', accounting_framework: 'k2', entity_type: 'ekonomisk_forening' } }) // read-back
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { entity_type: 'ekonomisk_forening' },
    })
    const { status, body } = await parseJsonResponse<{ data: { entity_type: string } }>(
      await PATCH(req, routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.entity_type).toBe('ekonomisk_forening')
    expect(supabase.rpc).toHaveBeenCalledWith('correct_company_entity_type', {
      p_company_id: 'company-1',
      p_entity_type: 'ekonomisk_forening',
    })
  })

  it('maps a refused legal-form change to a conflict with the Swedish reason', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } }) // current row
    enqueue({ data: { ok: false, code: 'ENTITY_TYPE_CHANGE_BOOKS_NOT_EMPTY', journal_entries: 3 } })
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { entity_type: 'ekonomisk_forening' },
    })
    const { status, body } = await parseJsonResponse<{ error: string; code: string }>(
      await PATCH(req, routeParams),
    )
    expect(status).toBe(409)
    expect(body.code).toBe('ENTITY_TYPE_CHANGE_BOOKS_NOT_EMPTY')
    expect(body.error).toContain('verifikat')
  })

  it('rejects an unknown legal form with 400 before touching the database', async () => {
    const req = createMockRequest('/api/company/current', {
      method: 'PATCH',
      body: { entity_type: 'handelsbolag' },
    })
    const { status } = await parseJsonResponse<{ error: string }>(await PATCH(req, routeParams))
    expect(status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('updates the framework for an aktiebolag', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } }) // entity check
    enqueue({ data: { id: 'company-1', accounting_framework: 'k3', entity_type: 'aktiebolag' } }) // update

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
