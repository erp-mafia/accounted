/**
 * Tests for POST /api/dimensions/[id]/values (create dimension value).
 *
 * Covers: 401, the strict Fortnox code format (400), 404 on a foreign
 * dimension, the duplicate-code conflict (409 with Swedish message), the
 * dates-on-resets-annually rejection (400), atomic create-as-archived
 * (is_active=false), and the happy path.
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

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../[id]/values/route'

const params = () => createMockRouteParams({ id: 'dim-1' })

describe('POST /api/dimensions/[id]/values', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code: 'P001', name: 'Projekt Björk' },
    })
    const response = await POST(request, params())

    expect(response.status).toBe(401)
  })

  it.each([
    ['space in code', 'P 001'],
    ['too long (>20 chars)', 'A'.repeat(21)],
    ['SIE-breaking char', 'P{1}'],
  ])('rejects an invalid code (%s) with 400', async (_label, code) => {
    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code, name: 'Projekt' },
    })
    const response = await POST(request, params())

    expect(response.status).toBe(400)
  })

  it('rejects end_date before start_date with 400', async () => {
    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code: 'P001', name: 'Projekt', start_date: '2026-06-01', end_date: '2026-01-01' },
    })
    const response = await POST(request, params())

    expect(response.status).toBe(400)
  })

  it('returns 404 when the dimension does not belong to the company', async () => {
    enqueue({ data: null }) // dimension maybeSingle

    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code: 'P001', name: 'Projekt Björk' },
    })
    const response = await POST(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_NOT_FOUND')
  })

  it('rejects start/end dates on a resets-annually dimension with 400', async () => {
    // Kostnadsställe-style dims reset annually — value date ranges are only
    // meaningful on accumulating dims (projekt).
    enqueue({ data: { id: 'dim-1', resets_annually: true } })

    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code: 'KS01', name: 'Kontoret', start_date: '2026-01-01' },
    })
    const response = await POST(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DIMENSION_VALUE_DATES_NOT_ALLOWED')
    expect(body.error.message).toBe(
      'Datum kan bara sättas på ackumulerande dimensioner (t.ex. projekt).',
    )
  })

  it('creates a value as archived when is_active=false (atomic, no follow-up PATCH)', async () => {
    enqueue({ data: { id: 'dim-1', resets_annually: false } })
    enqueue({
      data: {
        id: 'v2', dimension_id: 'dim-1', code: 'NEDLAGD', name: 'Nedlagd avdelning',
        is_active: false, start_date: null, end_date: null,
      },
    })

    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code: 'NEDLAGD', name: 'Nedlagd avdelning', is_active: false },
    })
    const response = await POST(request, params())
    const { status, body } = await parseJsonResponse<{ data: { id: string; is_active: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('v2')
    expect(body.data.is_active).toBe(false)
  })

  it('returns 409 with a Swedish message on a duplicate code', async () => {
    enqueue({ data: { id: 'dim-1' } })
    enqueue({ error: { code: '23505', message: 'duplicate key value' } })

    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code: 'P001', name: 'Projekt Björk' },
    })
    const response = await POST(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('DIMENSION_VALUE_DUPLICATE_CODE')
    expect(body.error.message).toBe('Ett värde med samma kod finns redan i dimensionen.')
  })

  it('creates a value (happy path, Swedish chars allowed in code)', async () => {
    enqueue({ data: { id: 'dim-1' } })
    enqueue({
      data: {
        id: 'v1', dimension_id: 'dim-1', code: 'GÖTEBORG', name: 'Göteborgskontoret',
        is_active: true, start_date: null, end_date: null,
      },
    })

    const request = createMockRequest('/api/dimensions/dim-1/values', {
      method: 'POST',
      body: { code: 'GÖTEBORG', name: 'Göteborgskontoret' },
    })
    const response = await POST(request, params())
    const { status, body } = await parseJsonResponse<{ data: { id: string; code: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('v1')
    expect(body.data.code).toBe('GÖTEBORG')
  })
})
