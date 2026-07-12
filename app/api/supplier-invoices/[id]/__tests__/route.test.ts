import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { DELETE } from '../route'

describe('DELETE /api/supplier-invoices/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  function deleteRequest() {
    return DELETE(
      createMockRequest('/api/supplier-invoices/si-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'si-1' }),
    )
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await deleteRequest()
    expect(response.status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null, error: null })

    const response = await deleteRequest()
    expect(response.status).toBe(404)
  })

  it('blocks deletion of credit notes', async () => {
    enqueue({
      data: { status: 'registered', registration_journal_entry_id: null, is_credit_note: true },
    })

    const { status } = await parseJsonResponse(await deleteRequest())
    expect(status).toBe(400)
  })

  it('blocks deletion when a registration journal entry exists', async () => {
    enqueue({
      data: {
        status: 'registered',
        registration_journal_entry_id: 'je-1',
        is_credit_note: false,
      },
    })

    const response = await deleteRequest()
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_DELETE_HAS_BOOKING')
    expect(body.error.details.reason).toBe('registration_journal_entry')
    // Items must NOT have been deleted (only the existence fetch ran).
    expect(mockSupabase.from).toHaveBeenCalledTimes(1)
  })

  it('blocks deletion when an accrual schedule references the invoice', async () => {
    enqueue({
      data: {
        status: 'registered',
        registration_journal_entry_id: null,
        is_credit_note: false,
      },
    })
    // accrual_schedules lookup finds a linked schedule (ON DELETE RESTRICT
    // would otherwise fail AFTER the items were already deleted).
    enqueue({ data: { id: 'sched-1' } })

    const response = await deleteRequest()
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string; scheduleId: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_DELETE_HAS_BOOKING')
    expect(body.error.details.reason).toBe('accrual_schedule')
    expect(body.error.details.scheduleId).toBe('sched-1')
    // Only the existence fetch + schedule lookup ran: no item deletion.
    expect(mockSupabase.from).toHaveBeenCalledTimes(2)
  })

  it('deletes an unbooked registered invoice', async () => {
    enqueue({
      data: {
        status: 'registered',
        registration_journal_entry_id: null,
        is_credit_note: false,
      },
    })
    enqueue({ data: null }) // accrual_schedules lookup: none
    enqueue({ data: null }) // items delete
    enqueue({ data: null }) // invoice delete

    const response = await deleteRequest()
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
