/**
 * Tests for PATCH /api/dimensions/[id] (update dimension) and
 * DELETE /api/dimensions/[id] (remove an unused custom dimension, #2219).
 *
 * Covers: 401, empty-body validation (400), 404, the is_system name-lock
 * ("Systemdimensioner kan inte döpas om", 400 DIMENSION_SYSTEM_RENAME),
 * archiving a system dimension (allowed), and the happy rename of a custom
 * dimension.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { PATCH, DELETE } from '../[id]/route'

const params = () => createMockRouteParams({ id: 'dim-1' })

describe('PATCH /api/dimensions/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/dimensions/dim-1', {
      method: 'PATCH',
      body: { name: 'Avdelning' },
    })
    const response = await PATCH(request, params())

    expect(response.status).toBe(401)
  })

  it('rejects an empty body with 400', async () => {
    const request = createMockRequest('/api/dimensions/dim-1', { method: 'PATCH', body: {} })
    const response = await PATCH(request, params())

    expect(response.status).toBe(400)
  })

  it('returns 404 when the dimension does not belong to the company', async () => {
    enqueue({ data: null }) // maybeSingle fetch

    const request = createMockRequest('/api/dimensions/dim-1', {
      method: 'PATCH',
      body: { name: 'Avdelning' },
    })
    const response = await PATCH(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_NOT_FOUND')
  })

  it('rejects renaming a system dimension with 400 DIMENSION_SYSTEM_RENAME', async () => {
    enqueue({ data: { id: 'dim-1', name: 'Kostnadsställe', is_system: true } })

    const request = createMockRequest('/api/dimensions/dim-1', {
      method: 'PATCH',
      body: { name: 'Avdelning' },
    })
    const response = await PATCH(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DIMENSION_SYSTEM_RENAME')
    expect(body.error.message).toBe('Systemdimensioner kan inte döpas om.')
  })

  it('allows archiving a system dimension (is_active only, no rename)', async () => {
    enqueue({ data: { id: 'dim-1', name: 'Kostnadsställe', is_system: true } })
    enqueue({
      data: {
        id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe',
        resets_annually: true, is_system: true, is_active: false, sort_order: 10,
      },
    })

    const request = createMockRequest('/api/dimensions/dim-1', {
      method: 'PATCH',
      body: { is_active: false },
    })
    const response = await PATCH(request, params())
    const { status, body } = await parseJsonResponse<{ data: { is_active: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.is_active).toBe(false)
  })

  it('renames a non-system dimension (happy path)', async () => {
    enqueue({ data: { id: 'dim-1', name: 'Dimension 7', is_system: false } })
    enqueue({
      data: {
        id: 'dim-1', sie_dim_no: 7, name: 'Avdelning',
        resets_annually: true, is_system: false, is_active: true, sort_order: 30,
      },
    })

    const request = createMockRequest('/api/dimensions/dim-1', {
      method: 'PATCH',
      body: { name: 'Avdelning', sort_order: 30 },
    })
    const response = await PATCH(request, params())
    const { status, body } = await parseJsonResponse<{ data: { name: string; sort_order: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.name).toBe('Avdelning')
    expect(body.data.sort_order).toBe(30)
  })
})

describe('DELETE /api/dimensions/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  const del = () => DELETE(createMockRequest('/api/dimensions/dim-1', { method: 'DELETE' }), params())

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await del()
    expect(response.status).toBe(401)
  })

  it('returns 404 when the dimension does not belong to the company', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await del())
    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_NOT_FOUND')
  })

  it('refuses a system dimension with 400 DIMENSION_SYSTEM_DELETE before touching the DB', async () => {
    enqueue({ data: { id: 'dim-1', name: 'Kostnadsställe', is_system: true } })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await del())
    expect(status).toBe(400)
    expect(body.error.code).toBe('DIMENSION_SYSTEM_DELETE')
    expect(body.error.message).toContain('avaktivera')
  })

  it('surfaces the DB guard verbatim as 409 DIMENSION_REFERENCED when posted lines carry the number', async () => {
    enqueue({ data: { id: 'dim-1', name: 'Avdelning', is_system: false } })
    enqueue({
      data: null,
      error: {
        code: 'P0001',
        message: 'Dimensionen 7 (Avdelning) används på bokförda verifikat och kan inte tas bort — avaktivera den istället.',
      },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await del())
    expect(status).toBe(409)
    expect(body.error.code).toBe('DIMENSION_REFERENCED')
    expect(body.error.message).toContain('Avdelning')
  })

  it('deletes an unused custom dimension (happy path)', async () => {
    enqueue({ data: { id: 'dim-1', name: 'Avdelning', is_system: false } })
    enqueue({ data: [{ id: 'dim-1' }] })
    const { status, body } = await parseJsonResponse<{ success: boolean }>(await del())
    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
