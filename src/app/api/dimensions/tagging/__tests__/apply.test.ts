/**
 * Tests for POST /api/dimensions/tagging/apply (bulk retag via the
 * retag_line_dimensions RPC).
 *
 * Covers: 401, body validation (400 for empty line_ids / short reason / bad
 * dimensions bag), the happy path (per-line RPC fan-out with p_user_id and
 * changed/unchanged aggregation) and partial failure: the route returns 200
 * with the raw Swedish RPC message per failed line.
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

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../apply/route'

const noParams = { params: Promise.resolve({}) }

const LINE_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const LINE_B = '9b2b6c9e-8c7d-4e5f-8a1b-2c3d4e5f6a7b'

const validBody = {
  line_ids: [LINE_A, LINE_B],
  dimensions: { '1': 'KS01', '6': 'P001' },
  reason: 'Rättelse av projektkod',
}

const request = (body: unknown) =>
  createMockRequest('/api/dimensions/tagging/apply', { method: 'POST', body })

type ApplyBody = {
  data: {
    retagged: number
    unchanged: number
    failed: { line_id: string; error: string }[]
  }
}

describe('POST /api/dimensions/tagging/apply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWritePermissionMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(request(validBody), noParams)

    expect(response.status).toBe(401)
  })

  it('rejects viewers via requireWrite', async () => {
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(request(validBody), noParams)

    expect(response.status).toBe(403)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when line_ids is empty', async () => {
    const response = await POST(request({ ...validBody, line_ids: [] }), noParams)

    expect(response.status).toBe(400)
  })

  it('returns 400 when the reason is shorter than 3 chars', async () => {
    const response = await POST(request({ ...validBody, reason: 'ab' }), noParams)

    expect(response.status).toBe(400)
  })

  it('returns 400 for a malformed dimensions bag', async () => {
    const response = await POST(
      request({ ...validBody, dimensions: { '0': 'KS01' } }),
      noParams,
    )

    expect(response.status).toBe(400)
  })

  it('calls the RPC once per line and aggregates changed/unchanged', async () => {
    enqueue({ data: { changed: true, log_id: 'log-1' } })
    enqueue({ data: { changed: false, log_id: null } })

    const response = await POST(request(validBody), noParams)
    const { status, body } = await parseJsonResponse<ApplyBody>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ retagged: 1, unchanged: 1, failed: [] })

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, 'retag_line_dimensions', {
      p_company_id: 'company-1',
      p_line_id: LINE_A,
      p_dimensions: { '1': 'KS01', '6': 'P001' },
      p_reason: 'Rättelse av projektkod',
      p_user_id: 'user-1',
    })
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'retag_line_dimensions', {
      p_company_id: 'company-1',
      p_line_id: LINE_B,
      p_dimensions: { '1': 'KS01', '6': 'P001' },
      p_reason: 'Rättelse av projektkod',
      p_user_id: 'user-1',
    })
  })

  it('accepts an empty dimensions bag (replace mode clears the tags)', async () => {
    enqueue({ data: { changed: true, log_id: 'log-1' } })

    const response = await POST(
      request({ line_ids: [LINE_A], dimensions: {}, reason: 'Tar bort felaktig tagg' }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<ApplyBody>(response)

    expect(status).toBe(200)
    expect(body.data.retagged).toBe(1)
    expect(supabase.rpc).toHaveBeenCalledWith('retag_line_dimensions', {
      p_company_id: 'company-1',
      p_line_id: LINE_A,
      p_dimensions: {},
      p_reason: 'Tar bort felaktig tagg',
      p_user_id: 'user-1',
    })
  })

  it('returns 200 with per-line errors on partial failure', async () => {
    enqueue({ data: { changed: true, log_id: 'log-1' } })
    enqueue({
      error: {
        message:
          'Perioden är låst: använd rättelseverifikat (storno) för att ändra dimensioner.',
      },
    })

    const response = await POST(request(validBody), noParams)
    const { status, body } = await parseJsonResponse<ApplyBody>(response)

    expect(status).toBe(200)
    expect(body.data.retagged).toBe(1)
    expect(body.data.unchanged).toBe(0)
    expect(body.data.failed).toEqual([
      {
        line_id: LINE_B,
        // Raw Swedish RPC message passes through untouched.
        error:
          'Perioden är låst: använd rättelseverifikat (storno) för att ändra dimensioner.',
      },
    ])
  })

  it('keeps processing after a failure (failure first, success second)', async () => {
    enqueue({ error: { message: 'Verifikationsraden hittades inte.' } })
    enqueue({ data: { changed: true, log_id: 'log-2' } })

    const response = await POST(request(validBody), noParams)
    const { status, body } = await parseJsonResponse<ApplyBody>(response)

    expect(status).toBe(200)
    expect(body.data.retagged).toBe(1)
    expect(body.data.failed).toHaveLength(1)
    expect(body.data.failed[0].line_id).toBe(LINE_A)
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })
})
