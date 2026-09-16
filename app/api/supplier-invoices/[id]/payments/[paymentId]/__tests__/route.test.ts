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

  function call() {
    return DELETE(
      createMockRequest('/api/supplier-invoices/inv-1/payments/pay-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1', paymentId: 'pay-1' }),
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
        supplierInvoiceId: 'inv-1',
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
      supplierInvoiceId: 'inv-1',
      paymentId: 'pay-1',
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
