import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockUnlink = vi.fn()
vi.mock('@/lib/invoices/supplier-voucher-matching', () => ({
  unlinkSupplierInvoiceFromVoucher: (...args: unknown[]) => mockUnlink(...args),
}))

import { DELETE } from '../route'

describe('DELETE /api/supplier-invoices/[id]/payments/[paymentId]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
  const PAYMENT_ID = '22222222-2222-4222-8222-222222222222'

  function call() {
    return DELETE(
      createMockRequest(`/api/supplier-invoices/${INVOICE_ID}/payments/${PAYMENT_ID}`, { method: 'DELETE' }),
      createMockRouteParams({ id: INVOICE_ID, paymentId: PAYMENT_ID }),
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await call()
    expect(response.status).toBe(401)
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('addresses the payment through both path segments', async () => {
    mockUnlink.mockResolvedValue({
      ok: true,
      result: {
        supplierInvoiceId: INVOICE_ID,
        journalEntryId: 'je-1',
        paymentAmount: 859,
        invoiceStatus: 'approved',
        paidAmount: 0,
        remainingAmount: 3500,
      },
    })

    const response = await call()
    const { body } = await parseJsonResponse<{ data?: Record<string, unknown>; error?: Record<string, unknown> }>(response)

    expect(response.status).toBe(200)
    // The invoice id is not decoration: the RPC scopes the row lookup by it, so
    // a payment id belonging to another payable in the same company misses.
    expect(mockUnlink).toHaveBeenCalledWith(mockSupabase, 'user-1', 'company-1', {
      supplierInvoiceId: INVOICE_ID,
      paymentId: PAYMENT_ID,
    })
    expect(body.data!.invoice_status).toBe('approved')
    expect(body.data!.remaining_amount).toBe(3500)
    expect(body.data!.payment_amount).toBe(859)
  })

  it('returns 404 when the payment is not on this invoice', async () => {
    mockUnlink.mockResolvedValue({ ok: false, code: 'UNLINK_SI_PAYMENT_NOT_FOUND' })

    const response = await call()
    const { body } = await parseJsonResponse<{ data?: Record<string, unknown>; error?: Record<string, unknown> }>(response)

    expect(response.status).toBe(404)
    expect(body.error!.code).toBe('UNLINK_SI_PAYMENT_NOT_FOUND')
  })

  it('refuses a payment that has its own booked voucher, and says storno instead', async () => {
    mockUnlink.mockResolvedValue({
      ok: false,
      code: 'UNLINK_SI_PAYMENT_BOOKED_PAYMENT',
      details: { source_type: 'supplier_invoice_paid', journal_entry_id: 'je-9' },
    })

    const response = await call()
    const { body } = await parseJsonResponse<{ data?: Record<string, unknown>; error?: Record<string, unknown> }>(response)

    expect(response.status).toBe(409)
    expect(body.error!.code).toBe('UNLINK_SI_PAYMENT_BOOKED_PAYMENT')
    expect(body.error!.message).toContain('storno')
    expect((body.error!.details as Record<string, unknown>).source_type).toBe('supplier_invoice_paid')
  })

  it('rejects a malformed payment id without reaching the database', async () => {
    const response = await DELETE(
      createMockRequest('/api/supplier-invoices/inv-1/payments/not-a-uuid', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1', paymentId: 'not-a-uuid' }),
    )
    const { body } = await parseJsonResponse<{ error?: Record<string, unknown> }>(response)

    // Otherwise Postgres raises 22P02 and the caller gets a 500 that invites a
    // retry which cannot succeed.
    expect(response.status).toBe(404)
    expect(body.error!.code).toBe('UNLINK_SI_PAYMENT_NOT_FOUND')
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('refuses when the invoice is not settled at all', async () => {
    mockUnlink.mockResolvedValue({
      ok: false,
      code: 'UNLINK_SI_PAYMENT_INVOICE_NOT_SETTLED',
      details: { status: 'credited' },
    })

    const response = await call()
    expect(response.status).toBe(409)
  })
})
