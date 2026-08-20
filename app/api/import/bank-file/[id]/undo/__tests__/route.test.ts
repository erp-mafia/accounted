/**
 * Tests for DELETE /api/import/bank-file/[id]/undo (#1672).
 *
 * The route has no request body (nothing to validate); the interesting
 * surface is auth, the owner/admin gate, batch lookup, and the RPC report
 * pass-through including the legacy no-link refusal.
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

const getCompanyRoleMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: (...args: unknown[]) => getCompanyRoleMock(...args),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { DELETE } from '../route'

const params = { params: Promise.resolve({ id: 'import-1' }) }

function makeRequest() {
  return createMockRequest('/api/import/bank-file/import-1/undo', { method: 'DELETE' })
}

describe('DELETE /api/import/bank-file/[id]/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(makeRequest(), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for non-owner/admin roles', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })

    const response = await DELETE(makeRequest(), params)
    const { body } = await parseJsonResponse<{ data?: Record<string, number>; error?: { code: string } }>(response)
    expect(response.status).toBe(403)
    expect(body.error?.code).toBe('BANK_FILE_UNDO_FORBIDDEN')
  })

  it('returns 404 when the import does not exist in the active company', async () => {
    enqueue({ data: null }) // bank_file_imports lookup: no row

    const response = await DELETE(makeRequest(), params)
    const { body } = await parseJsonResponse<{ data?: Record<string, number>; error?: { code: string } }>(response)
    expect(response.status).toBe(404)
    expect(body.error?.code).toBe('BANK_FILE_UNDO_NOT_FOUND')
  })

  it('returns 409 when the import is already undone', async () => {
    enqueue({ data: { id: 'import-1', status: 'undone', imported_count: 12 } })

    const response = await DELETE(makeRequest(), params)
    const { body } = await parseJsonResponse<{ data?: Record<string, number>; error?: { code: string } }>(response)
    expect(response.status).toBe(409)
    expect(body.error?.code).toBe('BANK_FILE_UNDO_BAD_STATUS')
  })

  it('returns 409 NO_LINK for legacy imports without linked transactions', async () => {
    enqueue({ data: { id: 'import-1', status: 'completed', imported_count: 12 } })
    enqueue({
      data: null,
      error: { message: 'Import import-1 has no linked transactions (imported before batch linking); undo is not available for it' },
    })

    const response = await DELETE(makeRequest(), params)
    const { body } = await parseJsonResponse<{ data?: Record<string, number>; error?: { code: string } }>(response)
    expect(response.status).toBe(409)
    expect(body.error?.code).toBe('BANK_FILE_UNDO_NO_LINK')
  })

  it('returns 500 when the RPC fails for another reason', async () => {
    enqueue({ data: { id: 'import-1', status: 'completed', imported_count: 12 } })
    enqueue({ data: null, error: { message: 'boom' } })

    const response = await DELETE(makeRequest(), params)
    const { body } = await parseJsonResponse<{ data?: Record<string, number>; error?: { code: string } }>(response)
    expect(response.status).toBe(500)
    expect(body.error?.code).toBe('BANK_FILE_UNDO_FAILED')
  })

  it('undoes the import and returns the RPC report (happy path)', async () => {
    enqueue({ data: { id: 'import-1', status: 'completed', imported_count: 12 } })
    enqueue({
      data: {
        deleted: 9,
        deleted_ignored: 2,
        skipped_booked: 2,
        skipped_matched: 1,
      },
    })

    const response = await DELETE(makeRequest(), params)
    const { body } = await parseJsonResponse<{ data?: Record<string, number>; error?: { code: string } }>(response)
    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      deleted: 9,
      deleted_ignored: 2,
      skipped_booked: 2,
      skipped_matched: 1,
    })

    // The RPC is called with explicit company + actor scoping.
    expect(supabase.rpc).toHaveBeenCalledWith('undo_bank_file_import', {
      p_company_id: 'company-1',
      p_import_id: 'import-1',
      p_user_id: 'user-1',
    })
  })
})
