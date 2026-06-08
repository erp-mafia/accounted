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

const mockLink = vi.fn()
vi.mock('@/lib/invoices/supplier-voucher-matching', () => ({
  linkSupplierInvoiceToVoucher: (...args: unknown[]) => mockLink(...args),
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

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_JE_UUID = '550e8400-e29b-41d4-a716-446655440001'
const mockUser = { id: 'user-1', email: 'test@test.se' }

describe('POST /api/supplier-invoices/[id]/link-to-voucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 400 when journal_entry_id is missing', async () => {
    const request = createMockRequest(`/api/supplier-invoices/${VALID_UUID}/link-to-voucher`, {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: VALID_UUID }))
    expect(response.status).toBe(400)
  })

  it('returns 200 with the linked payment payload on success', async () => {
    mockLink.mockResolvedValue({
      ok: true,
      result: {
        paymentId: 'sip-1',
        invoiceStatus: 'paid',
        paidAmount: 1000,
        remainingAmount: 0,
        paymentAmount: 1000,
        journalEntryId: VALID_JE_UUID,
      },
    })

    const request = createMockRequest(`/api/supplier-invoices/${VALID_UUID}/link-to-voucher`, {
      method: 'POST',
      body: { journal_entry_id: VALID_JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: VALID_UUID }))
    const { status, body } = await parseJsonResponse<{
      data: {
        invoice_status: string
        paid_amount: number
        remaining_amount: number
        payment_amount: number
        payment_id: string
        journal_entry_id: string
      }
    }>(response)
    expect(status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(body.data.paid_amount).toBe(1000)
    expect(body.data.remaining_amount).toBe(0)
    expect(body.data.payment_id).toBe('sip-1')
    expect(body.data.journal_entry_id).toBe(VALID_JE_UUID)
  })

  it('maps a structured failure code to the correct HTTP status', async () => {
    mockLink.mockResolvedValue({
      ok: false,
      code: 'LINK_SI_VOUCHER_NO_AP_DEBIT',
      details: { source_type: 'opening_balance' },
    })

    const request = createMockRequest(`/api/supplier-invoices/${VALID_UUID}/link-to-voucher`, {
      method: 'POST',
      body: { journal_entry_id: VALID_JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: VALID_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('LINK_SI_VOUCHER_NO_AP_DEBIT')
  })
})
