/**
 * POST /api/invoices/[id]/mark-paid: the door's side of the sale-first rule
 * (lib/invoices/sale-first.ts). settleInvoicePayment owns the rule and has its
 * own suite; here it is stubbed so the test pins what the route answers when
 * the sale was booked first, and when the Bokför step refused it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

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

vi.mock('@/lib/company/entity-type', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/entity-type')>()),
  resolveCompanyEntityType: vi.fn(async () => 'aktiebolag'),
}))

vi.mock('@/lib/invoices/invoice-payee', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/invoice-payee')>()),
  resolveInvoiceSettlementAccount: vi.fn(async () => '1930'),
}))

vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: vi.fn(async () => []),
}))

const mockSettle = vi.fn()
vi.mock('@/lib/invoices/settle-invoice-payment', () => ({
  settleInvoicePayment: (...args: unknown[]) => mockSettle(...args),
}))

import { POST } from '../route'

function enqueueInvoiceAndSettings(overrides: Record<string, unknown> = {}) {
  const invoice = makeInvoice({
    id: 'inv-1',
    status: 'sent',
    total: 12500,
    customer: makeCustomer(),
    journal_entry_id: null,
    ...overrides,
  })
  enqueue({ data: invoice, error: null })
  enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
  return invoice
}

describe('POST /api/invoices/[id]/mark-paid: sale first (defer_invoice_booking)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.se' } } })
  })

  it('answers the sale verifikat the payment booked first, with the Bokför step warnings', async () => {
    enqueueInvoiceAndSettings()
    mockSettle.mockResolvedValue({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 12500,
      newRemaining: 0,
      journalEntryId: 'je-payment',
      paidAt: '2026-05-12T00:00:00.000Z',
      saleJournalEntryId: 'je-sale',
      warnings: [{ code: 'PDF_LINK_FAILED', message_sv: 'PDF saknas', message_en: 'PDF missing' }],
    })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST', body: { payment_date: '2026-05-12' } }),
      createMockRouteParams({ id: 'inv-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      journal_entry_id: string
      sale_journal_entry_id?: string
      warnings?: Array<{ code: string; message: string }>
    }>(response)

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-payment')
    expect(body.sale_journal_entry_id).toBe('je-sale')
    expect(body.warnings).toEqual([{ code: 'PDF_LINK_FAILED', message: 'PDF saknas' }])
    expect(mockSettle).toHaveBeenCalledTimes(1)
  })

  it('leaves the response unchanged when no sale was booked first (booked at issue, kontantmetoden)', async () => {
    enqueueInvoiceAndSettings({ journal_entry_id: 'je-registered' })
    mockSettle.mockResolvedValue({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 12500,
      newRemaining: 0,
      journalEntryId: 'je-payment',
      paidAt: '2026-05-12T00:00:00.000Z',
      saleJournalEntryId: null,
      warnings: [],
    })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST', body: { payment_date: '2026-05-12' } }),
      createMockRouteParams({ id: 'inv-1' }),
    )
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(response)

    expect(status).toBe(200)
    expect(body).not.toHaveProperty('sale_journal_entry_id')
    expect(body).not.toHaveProperty('warnings')
  })

  it('refuses the payment with the Bokför step code and details.sale_first', async () => {
    enqueueInvoiceAndSettings()
    mockSettle.mockResolvedValue({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: { reason: 'period_locked_at_set', invoice_date: '2026-01-15', sale_first: true, invoice_id: 'inv-1' },
      },
    })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST', body: { payment_date: '2026-05-12' } }),
      createMockRouteParams({ id: 'inv-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: Record<string, unknown> }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({ sale_first: true, invoice_id: 'inv-1', invoice_date: '2026-01-15' })
  })

  it('answers INVOICE_BOOK_INVALID_STATUS for a partially paid invoice the Bokför step cannot book', async () => {
    enqueueInvoiceAndSettings({ status: 'partially_paid', paid_amount: 2500, remaining_amount: 10000 })
    mockSettle.mockResolvedValue({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: {
        ok: false,
        code: 'INVOICE_BOOK_INVALID_STATUS',
        details: { currentStatus: 'partially_paid', sale_first: true, invoice_id: 'inv-1' },
      },
    })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST', body: { payment_date: '2026-05-12' } }),
      createMockRouteParams({ id: 'inv-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: Record<string, unknown> }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_INVALID_STATUS')
    expect(body.error.details).toMatchObject({ sale_first: true })
  })
})
