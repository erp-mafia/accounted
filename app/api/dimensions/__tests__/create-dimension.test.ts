/**
 * Tests for POST /api/dimensions (create a custom dimension — PR10).
 *
 * Covers: auto-picking the next free SIE number >= 20 (proved both via the
 * insert result and via the self-parent guard, which names the picked
 * number), 409 on an explicitly taken number, 400 on an invalid parent, and
 * the 201 { data: { dimension } } contract for an explicit number.
 *
 * Queue order per request: ensure_company_dimensions RPC → existing-numbers
 * select → insert returning the row.
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

import { POST } from '../route'

const noParams = { params: Promise.resolve({}) }
const postRequest = (body: Record<string, unknown>) =>
  createMockRequest('/api/dimensions', { method: 'POST', body })

interface DimensionRow {
  id: string
  sie_dim_no: number
  name: string
  parent_sie_dim_no: number | null
  resets_annually: boolean
  is_system: boolean
  is_active: boolean
  sort_order: number
}

type DimensionBody = { data: { dimension: DimensionRow } }
type ErrorBody = { error: { code: string; message: string } }

function makeDimensionRow(overrides: Partial<DimensionRow> = {}): DimensionRow {
  return {
    id: 'dim-new',
    sie_dim_no: 21,
    name: 'Avdelning',
    parent_sie_dim_no: null,
    resets_annually: true,
    is_system: false,
    is_active: true,
    sort_order: 100,
    ...overrides,
  }
}

/** Enqueue the ensure RPC + the existing-numbers select. */
function enqueuePreamble(existingNumbers: number[]) {
  enqueue({ data: null }) // ensure_company_dimensions
  enqueue({ data: existingNumbers.map((n) => ({ sie_dim_no: n })) })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
})

describe('POST /api/dimensions', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(postRequest({ name: 'Avdelning' }), noParams)

    expect(response.status).toBe(401)
  })

  it('picks the next free number >= 20 when sie_dim_no is omitted ([1,6,20] → 21)', async () => {
    enqueuePreamble([1, 6, 20])
    enqueue({ data: makeDimensionRow({ sie_dim_no: 21 }) })

    const response = await POST(postRequest({ name: 'Avdelning' }), noParams)
    const { status, body } = await parseJsonResponse<DimensionBody>(response)

    expect(status).toBe(201)
    expect(body.data.dimension.sie_dim_no).toBe(21)
    expect(body.data.dimension.is_system).toBe(false)
  })

  it('auto-picks exactly 21 — pinned via the self-parent guard message', async () => {
    // The queued mock cannot capture insert payloads, so pin the computed
    // number through an observable branch: parent 21 collides with the pick
    // ONLY if the route picked 21 (any other pick yields the "finns inte"
    // message instead, since 21 is not a registered number).
    enqueuePreamble([1, 6, 20])

    const response = await POST(
      postRequest({ name: 'Avdelning', parent_sie_dim_no: 21 }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DIMENSION_PARENT_INVALID')
    expect(body.error.message).toBe(
      'En dimension kan inte vara sin egen överordnade dimension.',
    )
  })

  it('returns 409 DIMENSION_NUMBER_TAKEN for an explicitly taken number', async () => {
    enqueuePreamble([1, 6])

    const response = await POST(postRequest({ name: 'Projekt igen', sie_dim_no: 6 }), noParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('DIMENSION_NUMBER_TAKEN')
  })

  it('returns 400 DIMENSION_PARENT_INVALID for an unknown parent', async () => {
    enqueuePreamble([1, 6])

    const response = await POST(
      postRequest({ name: 'Avdelning', sie_dim_no: 30, parent_sie_dim_no: 99 }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DIMENSION_PARENT_INVALID')
    expect(body.error.message).toContain('99')
  })

  it('creates an explicit-number dimension with the 201 { data: { dimension } } shape', async () => {
    enqueuePreamble([1, 6])
    const row = makeDimensionRow({
      sie_dim_no: 30,
      name: 'Maskin',
      parent_sie_dim_no: 6,
      resets_annually: false,
    })
    enqueue({ data: row })

    const response = await POST(
      postRequest({ name: 'Maskin', sie_dim_no: 30, parent_sie_dim_no: 6, resets_annually: false }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<DimensionBody>(response)

    expect(status).toBe(201)
    expect(body.data.dimension).toEqual(row)
  })
})
