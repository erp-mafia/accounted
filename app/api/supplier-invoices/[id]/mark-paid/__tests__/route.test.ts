import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
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

const mockCreateSupplierInvoicePaymentEntry = vi.fn()
const mockCreateSupplierInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoicePaymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoiceCashEntry(...args),
}))

import { eventBus } from '@/lib/events'

import { POST } from '../route'

describe('POST /api/supplier-invoices/[id]/mark-paid', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/supplier-invoices/si-999/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('SI_NOT_FOUND')
  })

  it('returns 400 when invoice is in wrong status', async () => {
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'paid',
      supplier: makeSupplier(),
      items: [],
    })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('SI_PAID_NOT_PAYABLE')
  })

  it('marks as fully paid with accrual method', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: no candidate transactions
    enqueue({ data: [], error: null })
    // Fetch company settings
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    // Record payment
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('paid')
    expect(body.paid_amount).toBe(10000)
    expect(body.remaining_amount).toBe(0)
    expect(body.journal_entry_id).toBe('je-1')
    expect(mockCreateSupplierInvoicePaymentEntry).toHaveBeenCalled()
  })

  it('marks as partially paid', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-2' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { amount: 5000 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('partially_paid')
    expect(body.paid_amount).toBe(5000)
    expect(body.remaining_amount).toBe(5000)
  })

  it('uses cash method journal entry when configured', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [
        {
          id: 'item-1',
          supplier_invoice_id: 'si-1',
          sort_order: 0,
          description: 'Material',
          quantity: 10,
          unit: 'st',
          unit_price: 800,
          line_total: 8000,
          account_number: '4010',
          vat_code: null,
          vat_rate: 0.25,
          vat_amount: 2000,
          reverse_charge_rate: null,
          created_at: '2024-06-01T00:00:00Z',
        },
      ],
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: no candidate transactions
    enqueue({ data: [], error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    mockCreateSupplierInvoiceCashEntry.mockResolvedValue({ id: 'je-3' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-3')
    expect(mockCreateSupplierInvoiceCashEntry).toHaveBeenCalled()
    expect(mockCreateSupplierInvoicePaymentEntry).not.toHaveBeenCalled()
  })

  it('returns 500 when journal entry creation fails (blocking — GL must succeed for payment)', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: no candidate transactions
    enqueue({ data: [], error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePaymentEntry.mockRejectedValue(new Error('Period locked'))

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('SI_PAID_FAILED')
  })

  it('returns 409 SI_PAID_LIKELY_DUPLICATE when an unlinked transaction matches', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: one likely-matching unlinked transaction
    enqueue({
      data: [
        {
          id: 'tx-99',
          date: '2026-05-10',
          amount: -10000,
          description: 'Faktura Leverantör AB',
          merchant_name: 'Leverantör AB',
          journal_entry_id: 'je-99',
        },
      ],
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { candidates: unknown[] } } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(mockCreateSupplierInvoicePaymentEntry).not.toHaveBeenCalled()
  })

  it('proceeds when force=true even with candidates present', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    // No candidates query happens because force=true skips it
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { force: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; status: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('paid')
    expect(mockCreateSupplierInvoicePaymentEntry).toHaveBeenCalled()
  })

  it('skips duplicate guard on partial payment (amount < remaining)', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    // Note: no candidates enqueue — guard is skipped for partial payments
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { amount: 3000 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ status: string }>(response)

    expect(status).toBe(200)
    expect(body.status).toBe('partially_paid')
  })

  it('emits supplier_invoice.paid event', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: no candidate transactions
    enqueue({ data: [], error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })
    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.paid',
        payload: expect.objectContaining({
          userId: 'user-1',
          paymentAmount: 10000,
        }),
      })
    )
  })
})
