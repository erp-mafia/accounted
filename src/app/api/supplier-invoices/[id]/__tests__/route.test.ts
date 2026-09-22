import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

import { DELETE, GET } from '../route'

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

  it('blocks deletion when a payment row references the invoice', async () => {
    // Belt-and-braces: payments normally move the status past the deletable
    // list, but a payment row must block deletion regardless.
    enqueue({
      data: {
        status: 'overdue',
        registration_journal_entry_id: null,
        is_credit_note: false,
      },
    })
    enqueue({ data: { id: 'pay-1' } }) // supplier_invoice_payments lookup

    const response = await deleteRequest()
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string; paymentId: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_DELETE_HAS_BOOKING')
    expect(body.error.details.reason).toBe('payments')
    expect(body.error.details.paymentId).toBe('pay-1')
    // Only the existence fetch + payments lookup ran: no item deletion.
    expect(mockSupabase.from).toHaveBeenCalledTimes(2)
  })

  it('blocks deletion when an accrual schedule references the invoice', async () => {
    enqueue({
      data: {
        status: 'registered',
        registration_journal_entry_id: null,
        is_credit_note: false,
      },
    })
    enqueue({ data: null }) // supplier_invoice_payments lookup: none
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
    // Existence fetch + payments lookup + schedule lookup: no item deletion.
    expect(mockSupabase.from).toHaveBeenCalledTimes(3)
  })

  it('blocks deletion for a paid invoice', async () => {
    enqueue({
      data: { status: 'paid', registration_journal_entry_id: null, is_credit_note: false },
    })

    const { status } = await parseJsonResponse(await deleteRequest())
    expect(status).toBe(400)
  })

  it('fails closed when the payment lookup errors', async () => {
    // A transient DB/RLS failure must block the delete rather than read as
    // "no payment exists".
    enqueue({
      data: { status: 'registered', registration_journal_entry_id: null, is_credit_note: false },
    })
    enqueue({ data: null, error: { message: 'permission denied' } })

    const { status } = await parseJsonResponse(await deleteRequest())
    expect(status).toBe(500)
    // Existence fetch + payments lookup only: no item deletion.
    expect(mockSupabase.from).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the accrual-schedule lookup errors', async () => {
    enqueue({
      data: { status: 'registered', registration_journal_entry_id: null, is_credit_note: false },
    })
    enqueue({ data: null }) // supplier_invoice_payments lookup: none
    enqueue({ data: null, error: { message: 'permission denied' } })

    const { status } = await parseJsonResponse(await deleteRequest())
    expect(status).toBe(500)
    // Existence fetch + payments + schedule lookups: no item deletion.
    expect(mockSupabase.from).toHaveBeenCalledTimes(3)
  })

  it('deletes an unbooked registered invoice', async () => {
    enqueue({
      data: {
        status: 'registered',
        registration_journal_entry_id: null,
        is_credit_note: false,
      },
    })
    enqueue({ data: null }) // supplier_invoice_payments lookup: none
    enqueue({ data: null }) // accrual_schedules lookup: none
    enqueue({ data: null }) // items delete
    enqueue({ data: null }) // invoice delete

    const response = await deleteRequest()
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('deletes an unbooked, unpaid overdue invoice', async () => {
    // The overdue cron flips unbooked invoices past due_date from
    // registered/approved to 'overdue'; a registered-only gate made them
    // permanently undeletable just by aging (support case 2026-07-26).
    enqueue({
      data: {
        status: 'overdue',
        registration_journal_entry_id: null,
        is_credit_note: false,
      },
    })
    enqueue({ data: null }) // supplier_invoice_payments lookup: none
    enqueue({ data: null }) // accrual_schedules lookup: none
    enqueue({ data: null }) // items delete
    enqueue({ data: null }) // invoice delete

    const response = await deleteRequest()
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})

describe('GET /api/supplier-invoices/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  function getRequest(id: string) {
    return GET(
      createMockRequest(`/api/supplier-invoices/${id}`, { method: 'GET' }),
      createMockRouteParams({ id }),
    )
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await getRequest('si-1')).status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    expect((await getRequest('missing')).status).toBe(404)
  })

  it('hydrates the credited original of a credit note with a company-scoped lookup', async () => {
    // credited_invoice_id is a self-reference, and a PostgREST embed on it
    // resolved to the one-to-many side (an empty array), which the detail
    // page rendered as "Krediterar: Ankomst #" with no number.
    enqueue({
      data: { id: 'cn-1', is_credit_note: true, credited_invoice_id: 'si-orig', items: [], payments: [] },
      error: null,
    })
    enqueue({ data: { id: 'si-orig', supplier_invoice_number: '528285626420', arrival_number: 4 }, error: null })

    const { status, body } = await parseJsonResponse<{ data: { credited_original: unknown } }>(await getRequest('cn-1'))
    expect(status).toBe(200)
    expect(body.data.credited_original).toEqual({
      id: 'si-orig',
      supplier_invoice_number: '528285626420',
      arrival_number: 4,
    })
    const eqCalls = findCalls('supplier_invoices', 'eq')
    expect(eqCalls).toContainEqual(['id', 'si-orig'])
    expect(eqCalls.filter((c) => c[0] === 'company_id')).toHaveLength(2)
  })

  it('leaves credited_original null on an ordinary invoice without a second query', async () => {
    enqueue({ data: { id: 'si-1', is_credit_note: false, credited_invoice_id: null, items: [], payments: [] }, error: null })

    const { status, body } = await parseJsonResponse<{ data: { credited_original: unknown } }>(await getRequest('si-1'))
    expect(status).toBe(200)
    expect(body.data.credited_original).toBeNull()
    expect(mockSupabase.from).toHaveBeenCalledTimes(1)
  })
})
