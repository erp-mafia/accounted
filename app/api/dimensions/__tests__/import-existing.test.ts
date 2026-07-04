/**
 * Tests for POST /api/dimensions/import-existing (backfill scan).
 *
 * Covers: 401, the empty-company early exit, the happy path where codes
 * found on journal lines but missing from the registry are created as
 * inactive placeholder values ({ created: n }), code sanitization (PR1
 * backfill parity), and duplicate-tolerant upserts.
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

import { POST } from '../import-existing/route'

const request = () => createMockRequest('/api/dimensions/import-existing', { method: 'POST' })
const noParams = { params: Promise.resolve({}) }

describe('POST /api/dimensions/import-existing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(request(), noParams)

    expect(response.status).toBe(401)
  })

  it('returns { created: 0 } when no line carries dimensions', async () => {
    enqueue({ data: null }) // ensure RPC
    enqueue({ data: [] })   // journal_entry_lines scan

    const response = await POST(request(), noParams)
    const { status, body } = await parseJsonResponse<{ created: number }>(response)

    expect(status).toBe(200)
    expect(body.created).toBe(0)
  })

  it('creates inactive placeholder values for codes missing from the registry', async () => {
    enqueue({ data: null }) // ensure RPC
    // Lines: KS01 (dim 1) appears twice, P001 (dim 6) once, BUTIK already registered.
    enqueue({
      data: [
        { id: 'l1', dimensions: { '1': 'KS01' } },
        { id: 'l2', dimensions: { '1': 'KS01', '6': 'P001' } },
        { id: 'l3', dimensions: { '1': 'BUTIK' } },
      ],
    })
    // Registry dims 1 & 6 exist (system dims).
    enqueue({
      data: [
        { id: 'dim-1', sie_dim_no: 1 },
        { id: 'dim-6', sie_dim_no: 6 },
      ],
    })
    // Existing values: BUTIK is already registered under dim 1.
    enqueue({ data: [{ dimension_id: 'dim-1', code: 'BUTIK' }] })
    // Upsert of the two missing values succeeds: created counts returned rows.
    enqueue({ data: [{ id: 'nv1' }, { id: 'nv2' }] })

    const response = await POST(request(), noParams)
    const { status, body } = await parseJsonResponse<{ created: number }>(response)

    expect(status).toBe(200)
    expect(body.created).toBe(2) // KS01 + P001; BUTIK skipped (already registered)
  })

  it('sanitizes candidate codes like the PR1 backfill and de-duplicates after sanitization', async () => {
    enqueue({ data: null }) // ensure RPC
    // 'KS"01"' and 'KS{01}' both sanitize to KS01 (one candidate); a 50-char
    // code is capped at 40; '"{}"' sanitizes to empty and is dropped entirely.
    enqueue({
      data: [
        { id: 'l1', dimensions: { '1': 'KS"01"' } },
        { id: 'l2', dimensions: { '1': 'KS{01}' } },
        { id: 'l3', dimensions: { '1': 'X'.repeat(50) } },
        { id: 'l4', dimensions: { '1': '"{}"' } },
      ],
    })
    enqueue({ data: [{ id: 'dim-1', sie_dim_no: 1 }] }) // registry dims
    enqueue({ data: [] }) // no existing values
    // Upsert returns the two surviving sanitized codes (KS01 + the capped one).
    enqueue({ data: [{ id: 'nv1' }, { id: 'nv2' }] })

    const response = await POST(request(), noParams)
    const { status, body } = await parseJsonResponse<{ created: number }>(response)

    expect(status).toBe(200)
    expect(body.created).toBe(2)
  })

  it('tolerates duplicates in the batch: created counts only the rows the upsert returned', async () => {
    enqueue({ data: null }) // ensure RPC
    enqueue({
      data: [
        { id: 'l1', dimensions: { '1': 'KS01' } },
        { id: 'l2', dimensions: { '1': 'KS02' } },
      ],
    })
    enqueue({ data: [{ id: 'dim-1', sie_dim_no: 1 }] }) // registry dims
    enqueue({ data: [] }) // existing-values snapshot missed a raced KS02
    // ignoreDuplicates upsert skips the conflicting row instead of aborting
    // the batch: only KS01 comes back.
    enqueue({ data: [{ id: 'nv1' }] })

    const response = await POST(request(), noParams)
    const { status, body } = await parseJsonResponse<{ created: number }>(response)

    expect(status).toBe(200)
    expect(body.created).toBe(1)
  })

  it('creates a registry dimension for an unregistered dim number found on lines', async () => {
    enqueue({ data: null }) // ensure RPC
    enqueue({ data: [{ id: 'l1', dimensions: { '7': 'AVD-A' } }] }) // lines
    // Registry only has the system dims: dim 7 is missing.
    enqueue({
      data: [
        { id: 'dim-1', sie_dim_no: 1 },
        { id: 'dim-6', sie_dim_no: 6 },
      ],
    })
    // Upsert of the missing dimension row returns its id.
    enqueue({ data: [{ id: 'dim-7', sie_dim_no: 7 }] })
    // No existing values.
    enqueue({ data: [] })
    // Value upsert succeeds.
    enqueue({ data: [{ id: 'nv1' }] })

    const response = await POST(request(), noParams)
    const { status, body } = await parseJsonResponse<{ created: number }>(response)

    expect(status).toBe(200)
    expect(body.created).toBe(1)
  })

  it('returns 500 DIMENSION_IMPORT_FAILED when the scan blows up', async () => {
    enqueue({ data: null }) // ensure RPC
    enqueue({ error: { message: 'relation missing' } }) // fetchAllRows throws

    const response = await POST(request(), noParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('DIMENSION_IMPORT_FAILED')
  })
})
