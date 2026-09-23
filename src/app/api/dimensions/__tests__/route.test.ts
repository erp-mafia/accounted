/**
 * Tests for GET /api/dimensions (dimension registry list).
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, the ensure-RPC failure path, and the contract
 * shape ({ dimensions: [...] } with values nested per dimension).
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

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

interface DimensionsBody {
  dimensions: Array<{
    id: string
    sie_dim_no: number
    name: string
    resets_annually: boolean
    is_system: boolean
    is_active: boolean
    sort_order: number
    values: Array<{
      id: string
      code: string
      name: string
      is_active: boolean
      start_date: string | null
      end_date: string | null
    }>
  }>
}

describe('GET /api/dimensions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/dimensions'), { params: Promise.resolve({}) })

    expect(response.status).toBe(401)
  })

  it('ensures system dims exist, then returns dimensions with nested values', async () => {
    // 1st DB hit: ensure_company_dimensions RPC.
    enqueue({ data: null })
    // 2nd: dimensions list (sorted by sort_order server-side).
    enqueue({
      data: [
        { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 },
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
      ],
    })
    // 3rd: dimension_values list (sorted by code server-side).
    enqueue({
      data: [
        { id: 'v1', dimension_id: 'dim-1', code: 'BUTIK', name: 'Butiken', is_active: true, start_date: null, end_date: null },
        { id: 'v2', dimension_id: 'dim-6', code: 'P001', name: 'Projekt Björk', is_active: false, start_date: '2026-01-01', end_date: '2026-06-30' },
      ],
    })

    const response = await GET(createMockRequest('/api/dimensions'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<DimensionsBody>(response)

    expect(status).toBe(200)
    expect(supabase.rpc).toHaveBeenCalledWith('ensure_company_dimensions', {
      p_company_id: 'company-1',
    })
    expect(body.dimensions).toHaveLength(2)
    expect(body.dimensions[0]).toMatchObject({
      id: 'dim-1',
      sie_dim_no: 1,
      name: 'Kostnadsställe',
      resets_annually: true,
      is_system: true,
      values: [
        { id: 'v1', code: 'BUTIK', name: 'Butiken', is_active: true, start_date: null, end_date: null },
      ],
    })
    expect(body.dimensions[1].values).toEqual([
      { id: 'v2', code: 'P001', name: 'Projekt Björk', is_active: false, start_date: '2026-01-01', end_date: '2026-06-30' },
    ])
  })

  it('returns a dimension with an empty values array when it has no values', async () => {
    enqueue({ data: null }) // ensure RPC
    enqueue({
      data: [
        { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 },
      ],
    })
    enqueue({ data: [] })

    const response = await GET(createMockRequest('/api/dimensions'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<DimensionsBody>(response)

    expect(status).toBe(200)
    expect(body.dimensions[0].values).toEqual([])
  })

  it('returns 500 when the ensure RPC fails', async () => {
    enqueue({ error: { code: 'XX000', message: 'boom' } })

    const response = await GET(createMockRequest('/api/dimensions'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBeTruthy()
  })
})
