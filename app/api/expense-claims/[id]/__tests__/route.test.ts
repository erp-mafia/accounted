/**
 * Auth-wiring + contract tests for DELETE /api/expense-claims/:id. The
 * service is mocked; these tests pin the 401, the result-code -> status
 * mapping (404 / 409 / 500) and the happy-path payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

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

const deleteMock = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  deleteExpenseClaim: (...args: unknown[]) => deleteMock(...args),
}))

import { DELETE } from '../route'

function del(id = 'claim-1') {
  return DELETE(
    createMockRequest(`/api/expense-claims/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) } as never,
  )
}

describe('DELETE /api/expense-claims/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    deleteMock.mockResolvedValue({ ok: true, reversal_entry_id: 'je-storno' })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await del()
    expect(response.status).toBe(401)
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('maps NOT_FOUND to 404', async () => {
    deleteMock.mockResolvedValue({ ok: false, code: 'NOT_FOUND' })
    const response = await del('missing')
    expect(response.status).toBe(404)
  })

  it('maps ALREADY_PAID and UNLINKED to 409', async () => {
    deleteMock.mockResolvedValue({ ok: false, code: 'ALREADY_PAID' })
    expect((await del()).status).toBe(409)
    deleteMock.mockResolvedValue({ ok: false, code: 'UNLINKED' })
    expect((await del()).status).toBe(409)
  })

  it('maps DELETE_FAILED to 500', async () => {
    deleteMock.mockResolvedValue({ ok: false, code: 'DELETE_FAILED', detail: 'db down' })
    expect((await del()).status).toBe(500)
  })

  it('returns the reversal entry id on success', async () => {
    const { status, body } = await parseJsonResponse<{
      data: { id: string; deleted: boolean; reversal_entry_id: string }
    }>(await del('claim-1'))
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'claim-1', deleted: true, reversal_entry_id: 'je-storno' })
    expect(deleteMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'claim-1')
  })
})
