/**
 * GET /api/invoices/[id]/mark-paid: what a payment of the invoice clears on
 * 1510, for the rows PaymentBookingDialog proposes. The real sale-first module
 * and carriedSekOf run; the Bokför step (bookInvoice) is mocked the way
 * lib/invoices/__tests__/settle-invoice-payment-sale-first.test.ts mocks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import type { Invoice } from '@/types'

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

vi.mock('@/lib/invoices/book-service', () => ({ bookInvoice: vi.fn() }))

import { bookInvoice } from '@/lib/invoices/book-service'
import { GET } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const DEFERRING = { accounting_method: 'accrual', defer_invoice_booking: true }

/** The sale of an öre invoice that books the öresavrundning: 1510 at the rounded "Att betala". */
const ORE_SALE_ENTRY = {
  entry_date: '2026-09-10',
  description: 'Kundfaktura F-1043',
  lines: [
    { account_number: '1510', debit_amount: 1000, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 799.8, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 199.95, line_description: null },
    { account_number: '3740', debit_amount: 0, credit_amount: 0.25, line_description: 'Öresavrundning' },
  ],
  total_debit: 1000,
  total_credit: 1000,
  balanced: true,
  note: 'preview',
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    currency: 'SEK',
    total: 999.75,
    paid_amount: 0,
    remaining_amount: 999.75,
    journal_entry_id: null,
    document_type: 'invoice',
    credited_invoice_id: null,
    ...overrides,
  }
}

function get() {
  return GET(createMockRequest('/api/invoices/inv-1/mark-paid'), createMockRouteParams({ id: 'inv-1' }))
}

describe('GET /api/invoices/[id]/mark-paid: what the payment clears on 1510', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    vi.mocked(bookInvoice).mockImplementation(async (_ctx, invoiceId, options) => {
      if (options?.dryRun) {
        return { ok: true, dryRun: true, preview: { invoice_id: invoiceId, journal_entry: ORE_SALE_ENTRY } }
      }
      return { ok: true, data: { invoice: { id: invoiceId } as Invoice, journal_entry_id: 'je-sale' }, warnings: [] }
    })
  })

  it('returns 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await get()
    expect(response.status).toBe(401)
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get())
    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_PAID_NOT_FOUND')
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('answers what the sale booked first leaves on 1510, not the reskontra, and writes nothing', async () => {
    enqueue({ data: invoiceRow(), error: null })
    enqueue({ data: DEFERRING, error: null }) // company_settings (the sale plan)

    const { status, body } = await parseJsonResponse<{ data: { carried_sek: number | null } }>(await get())

    expect(status).toBe(200)
    expect(body.data.carried_sek).toBe(1000)
    // Only the Bokför step's dry run: nothing is booked.
    expect(vi.mocked(bookInvoice).mock.calls).toHaveLength(1)
    expect(vi.mocked(bookInvoice).mock.calls[0]![2]).toEqual({ dryRun: true })
    // The ledger has no sale yet, so it is not asked.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('answers what the ledger carries for an invoice booked at issue', async () => {
    enqueue({ data: invoiceRow({ journal_entry_id: 'je-issue' }), error: null })
    enqueue({ data: { ok: true, sek: 1000 } }) // document_carried_sek: the issue booked the öre

    const { status, body } = await parseJsonResponse<{ data: { carried_sek: number | null } }>(await get())

    expect(status).toBe(200)
    expect(body.data.carried_sek).toBe(1000)
    expect(bookInvoice).not.toHaveBeenCalled()
    expect(mockSupabase.rpc).toHaveBeenCalledWith('document_carried_sek', expect.objectContaining({ p_document_id: 'inv-1' }))
  })

  it('answers the ledger, not the sale plan, for a foreign invoice booked first', async () => {
    enqueue({ data: invoiceRow({ currency: 'EUR', total: 100, remaining_amount: 100 }), error: null })
    enqueue({ data: { ok: false, reason: 'no_registration_voucher' } }) // document_carried_sek

    const { status, body } = await parseJsonResponse<{ data: { carried_sek: number | null } }>(await get())

    expect(status).toBe(200)
    expect(body.data.carried_sek).toBeNull()
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('asks the ledger when a concurrent Bokför booked the sale since the row was read', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_ALREADY_BOOKED' })
    enqueue({ data: invoiceRow(), error: null })
    enqueue({ data: DEFERRING, error: null }) // company_settings (the sale plan)
    enqueue({ data: { ok: true, sek: 1000 } }) // document_carried_sek: the concurrent sale

    const { status, body } = await parseJsonResponse<{ data: { carried_sek: number | null } }>(await get())

    expect(status).toBe(200)
    expect(body.data.carried_sek).toBe(1000)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('document_carried_sek', expect.objectContaining({ p_document_id: 'inv-1' }))
  })

  it('answers null when the Bokför step would refuse the sale: the payment is refused on its own', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_INVALID_STATUS' })
    enqueue({ data: invoiceRow(), error: null })
    enqueue({ data: DEFERRING, error: null }) // company_settings (the sale plan)

    const { status, body } = await parseJsonResponse<{ data: { carried_sek: number | null } }>(await get())

    expect(status).toBe(200)
    expect(body.data.carried_sek).toBeNull()
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('answers null for a company that books invoices at issue: nothing is booked first', async () => {
    enqueue({ data: invoiceRow(), error: null })
    enqueue({ data: { accounting_method: 'accrual', defer_invoice_booking: false }, error: null })

    const { status, body } = await parseJsonResponse<{ data: { carried_sek: number | null } }>(await get())

    expect(status).toBe(200)
    expect(body.data.carried_sek).toBeNull()
    expect(bookInvoice).not.toHaveBeenCalled()
  })
})
