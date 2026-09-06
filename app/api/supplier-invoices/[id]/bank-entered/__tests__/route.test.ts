import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

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

import { eventBus } from '@/lib/events'

import { POST } from '../route'

/**
 * "Inlagd i banken" (#2220): a mark, not a payment. The route writes one
 * nullable timestamp and nothing else; the trigger covered by
 * tests/pg/supplier-invoice-bank-entered.pg.test.ts clears it when a payment
 * lands.
 */
describe('POST /api/supplier-invoices/[id]/bank-entered', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  function post(body: unknown) {
    return POST(
      createMockRequest('/api/supplier-invoices/si-1/bank-entered', {
        method: 'POST',
        body,
      }),
      createMockRouteParams({ id: 'si-1' }),
    )
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await post({ entered: true })
    expect(response.status).toBe(401)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 when the body carries no boolean', async () => {
    const response = await post({ entered: 'yes' })
    expect(response.status).toBe(400)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist in the company', async () => {
    enqueue({ data: null })

    const response = await post({ entered: true })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('SI_NOT_FOUND')
    // Company scoping on the read (defense in depth alongside RLS).
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCall('supplier_invoices', 'update')).toBeUndefined()
  })

  it('marks an approved invoice and returns the timestamp', async () => {
    enqueue({ data: makeSupplierInvoice({ id: 'si-1', status: 'approved' }) })
    enqueue({ data: { id: 'si-1', bank_entered_at: '2026-09-06T10:00:00.000Z' } })

    const response = await post({ entered: true })
    const { status, body } = await parseJsonResponse<{
      data: { id: string; bank_entered_at: string | null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'si-1', bank_entered_at: '2026-09-06T10:00:00.000Z' })

    const payload = findCall('supplier_invoices', 'update')?.[0] as Record<string, unknown>
    // Only the mark is written: no status, amount or payment field moves.
    expect(Object.keys(payload)).toEqual(['bank_entered_at'])
    expect(payload.bank_entered_at).toEqual(expect.any(String))
    // Compare-and-set on the eligibility the read established.
    expect(findCall('supplier_invoices', 'in')).toEqual([
      'status',
      ['approved', 'overdue', 'partially_paid'],
    ])
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['is_credit_note', false])
  })

  it('keeps the first timestamp when marking an already-marked invoice', async () => {
    enqueue({
      data: makeSupplierInvoice({
        id: 'si-1',
        status: 'overdue',
        bank_entered_at: '2026-09-01T08:00:00.000Z',
      }),
    })
    enqueue({ data: { id: 'si-1', bank_entered_at: '2026-09-01T08:00:00.000Z' } })

    const response = await post({ entered: true })
    expect(response.status).toBe(200)

    const payload = findCall('supplier_invoices', 'update')?.[0] as Record<string, unknown>
    expect(payload.bank_entered_at).toBe('2026-09-01T08:00:00.000Z')
  })

  it('clears the mark without any status guard', async () => {
    enqueue({
      data: makeSupplierInvoice({
        id: 'si-1',
        status: 'paid',
        bank_entered_at: '2026-09-01T08:00:00.000Z',
      }),
    })
    enqueue({ data: { id: 'si-1', bank_entered_at: null } })

    const response = await post({ entered: false })
    const { status, body } = await parseJsonResponse<{
      data: { id: string; bank_entered_at: string | null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.bank_entered_at).toBeNull()
    expect(findCall('supplier_invoices', 'update')?.[0]).toEqual({ bank_entered_at: null })
    expect(findCall('supplier_invoices', 'in')).toBeUndefined()
  })

  it.each([
    ['registered', false],
    ['paid', false],
    ['credited', false],
    ['approved', true],
  ])('refuses to mark a %s invoice (credit note: %s)', async (invoiceStatus, isCreditNote) => {
    enqueue({
      data: makeSupplierInvoice({
        id: 'si-1',
        status: invoiceStatus as 'registered',
        is_credit_note: isCreditNote,
      }),
    })

    const response = await post({ entered: true })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { currentStatus: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BANK_ENTERED_NOT_PAYABLE')
    expect(body.error.details.currentStatus).toBe(invoiceStatus)
    expect(findCall('supplier_invoices', 'update')).toBeUndefined()
  })

  it('refuses when the compare-and-set matches no row (payment landed meanwhile)', async () => {
    enqueue({ data: makeSupplierInvoice({ id: 'si-1', status: 'approved' }) })
    enqueue({ data: null })

    const response = await post({ entered: true })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BANK_ENTERED_NOT_PAYABLE')
    expect(body.error.details.reason).toBe('race')
  })

  it('surfaces a database error from the update', async () => {
    enqueue({ data: makeSupplierInvoice({ id: 'si-1', status: 'approved' }) })
    enqueue({ data: null, error: { code: '42501', message: 'permission denied' } })

    const response = await post({ entered: true })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).not.toBe(200)
  })
})
