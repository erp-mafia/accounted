/**
 * Tests for PATCH/DELETE /api/dimensions/[id]/values/[valueId].
 *
 * The DELETE suite pins the retention-trigger contract: a P0001 raise from
 * enforce_dimension_value_retention surfaces as 409 DIMENSION_VALUE_REFERENCED
 * with the trigger's own Swedish message ("…arkivera det istället") so the UI
 * can toast it verbatim.
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

import { PATCH, DELETE } from '../[id]/values/[valueId]/route'

const params = () => createMockRouteParams({ id: 'dim-1', valueId: 'v1' })
const URL_PATH = '/api/dimensions/dim-1/values/v1'

describe('PATCH /api/dimensions/[id]/values/[valueId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest(URL_PATH, { method: 'PATCH', body: { name: 'Nytt namn' } })
    const response = await PATCH(request, params())

    expect(response.status).toBe(401)
  })

  it('rejects an empty body with 400', async () => {
    const request = createMockRequest(URL_PATH, { method: 'PATCH', body: {} })
    const response = await PATCH(request, params())

    expect(response.status).toBe(400)
  })

  it('returns 404 when the value does not exist in the company', async () => {
    enqueue({ error: { code: 'PGRST116', message: 'No rows found' } })

    const request = createMockRequest(URL_PATH, { method: 'PATCH', body: { name: 'Nytt namn' } })
    const response = await PATCH(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_VALUE_NOT_FOUND')
  })

  it('archives a value via is_active=false (happy path)', async () => {
    // The request carries end_date, so the route first checks the parent
    // dimension's resets_annually flag (accumulating → dates allowed).
    enqueue({ data: { id: 'dim-1', resets_annually: false } })
    enqueue({
      data: {
        id: 'v1', dimension_id: 'dim-1', code: 'BUTIK', name: 'Butiken',
        is_active: false, start_date: null, end_date: '2026-06-30',
      },
    })

    const request = createMockRequest(URL_PATH, {
      method: 'PATCH',
      body: { is_active: false, end_date: '2026-06-30' },
    })
    const response = await PATCH(request, params())
    const { status, body } = await parseJsonResponse<{ data: { is_active: boolean; code: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.is_active).toBe(false)
    // Code untouched: immutable in v1.
    expect(body.data.code).toBe('BUTIK')
  })

  it('rejects start/end dates on a resets-annually dimension with 400', async () => {
    enqueue({ data: { id: 'dim-1', resets_annually: true } })

    const request = createMockRequest(URL_PATH, {
      method: 'PATCH',
      body: { start_date: '2026-01-01' },
    })
    const response = await PATCH(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DIMENSION_VALUE_DATES_NOT_ALLOWED')
    expect(body.error.message).toBe(
      'Datum kan bara sättas på ackumulerande dimensioner (t.ex. projekt).',
    )
  })

  it('allows clearing dates (explicit null) without checking the dimension', async () => {
    // start_date: null clears the field, a harmless no-op on any dimension,
    // so the route must not spend a dimension fetch on it. The single queued
    // result feeds the update itself.
    enqueue({
      data: {
        id: 'v1', dimension_id: 'dim-1', code: 'BUTIK', name: 'Butiken',
        is_active: true, start_date: null, end_date: null,
      },
    })

    const request = createMockRequest(URL_PATH, {
      method: 'PATCH',
      body: { start_date: null, end_date: null },
    })
    const response = await PATCH(request, params())
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })
})

describe('DELETE /api/dimensions/[id]/values/[valueId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest(URL_PATH, { method: 'DELETE' })
    const response = await DELETE(request, params())

    expect(response.status).toBe(401)
  })

  it('surfaces the retention trigger as 409 with the trigger\'s Swedish message', async () => {
    const triggerMessage =
      'Värdet "BUTIK" används på bokförda verifikat och kan inte tas bort: arkivera det istället.'
    enqueue({ error: { code: 'P0001', message: triggerMessage } })

    const request = createMockRequest(URL_PATH, { method: 'DELETE' })
    const response = await DELETE(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('DIMENSION_VALUE_REFERENCED')
    // The trigger's message (naming the code) is surfaced verbatim for the toast.
    expect(body.error.message).toBe(triggerMessage)
    expect(body.error.message).toContain('arkivera det istället')
  })

  it('returns 404 when nothing was deleted', async () => {
    enqueue({ data: [] })

    const request = createMockRequest(URL_PATH, { method: 'DELETE' })
    const response = await DELETE(request, params())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_VALUE_NOT_FOUND')
  })

  it('deletes an unreferenced value (happy path)', async () => {
    enqueue({ data: [{ id: 'v1' }] })

    const request = createMockRequest(URL_PATH, { method: 'DELETE' })
    const response = await DELETE(request, params())
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
