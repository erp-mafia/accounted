import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const mockUnlink = vi.fn()
vi.mock('@/lib/invoices/supplier-voucher-unlink', () => ({
  unlinkSupplierInvoiceFromVoucher: (...args: unknown[]) => mockUnlink(...args),
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

import { POST } from '../route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const PAYMENT_ID = '550e8400-e29b-41d4-a716-446655440001'
const VOUCHER_ID = '550e8400-e29b-41d4-a716-446655440002'
const mockUser = { id: 'user-1', email: 'test@test.se' }

function post(body: unknown) {
  const request = createMockRequest(`/api/supplier-invoices/${INVOICE_ID}/unlink-voucher`, {
    method: 'POST',
    body,
  })
  return POST(request, createMockRouteParams({ id: INVOICE_ID }))
}

describe('POST /api/supplier-invoices/[id]/unlink-voucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated, and unlinks nothing', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await post({ payment_id: PAYMENT_ID })
    expect(response.status).toBe(401)
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('returns 400 when payment_id is missing or not a uuid', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ payment_id: 'not-a-uuid' })).status).toBe(400)
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('returns 404 when the payment row is not on the invoice', async () => {
    mockUnlink.mockResolvedValue({ ok: false, code: 'UNLINK_SI_VOUCHER_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ payment_id: PAYMENT_ID }),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('UNLINK_SI_VOUCHER_NOT_FOUND')
  })

  it('maps a refusal to 409 with a Swedish message that names the way out', async () => {
    mockUnlink.mockResolvedValue({
      ok: false,
      code: 'UNLINK_SI_VOUCHER_PAYMENT_VOUCHER',
      details: { source_type: 'supplier_invoice_paid' },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await post({ payment_id: PAYMENT_ID }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('UNLINK_SI_VOUCHER_PAYMENT_VOUCHER')
    expect(body.error.message).toContain('Makulera verifikationen')
  })

  it.each([
    'UNLINK_SI_VOUCHER_NOT_A_LINK',
    'UNLINK_SI_VOUCHER_SETOFF',
    'UNLINK_SI_VOUCHER_SETTLEMENT_EVIDENCE',
    'UNLINK_SI_VOUCHER_FOREIGN_CURRENCY',
    'UNLINK_SI_VOUCHER_INVOICE_NOT_SETTLED',
    'UNLINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED',
  ])('answers %s as a 409 under its own code', async (code) => {
    mockUnlink.mockResolvedValue({ ok: false, code })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await post({ payment_id: PAYMENT_ID }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe(code)
    expect(body.error.message.length).toBeGreaterThan(20)
  })

  it('returns 200 with the restored invoice state on success', async () => {
    mockUnlink.mockResolvedValue({
      ok: true,
      result: {
        paymentId: PAYMENT_ID,
        journalEntryId: VOUCHER_ID,
        unlinkedAmount: 1250,
        invoiceStatus: 'approved',
        paidAmount: 0,
        remainingAmount: 1250,
        documentOnVoucher: false,
      },
    })

    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await post({ payment_id: PAYMENT_ID }),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({
      payment_id: PAYMENT_ID,
      journal_entry_id: VOUCHER_ID,
      unlinked_amount: 1250,
      invoice_status: 'approved',
      paid_amount: 0,
      remaining_amount: 1250,
      document_on_voucher: false,
    })
    expect(mockUnlink).toHaveBeenCalledWith(mockSupabase, 'user-1', 'company-1', {
      supplierInvoiceId: INVOICE_ID,
      paymentId: PAYMENT_ID,
    })
  })
})
