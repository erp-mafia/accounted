/**
 * Staging of gnubok_mark_invoice_as_paid and gnubok_link_invoice_to_voucher
 * under the sale-first rule (lib/invoices/sale-first.ts): a deferring
 * company's invoice sent without its verifikat gets its sale booked first on
 * approval. Staging runs the Bokför step's dry run, so a refusal there is
 * refused at staging with the same code (nothing staged), and the approver
 * sees the sale verifikat in preview.sale_entry. The plan is stubbed (the rule
 * has its own suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const { mockPlan } = vi.hoisted(() => ({ mockPlan: vi.fn() }))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: mockPlan,
}))

vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: vi.fn(async () => []),
}))

const { mockValidateLink } = vi.hoisted(() => ({ mockValidateLink: vi.fn() }))
vi.mock('@/lib/invoices/voucher-matching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/voucher-matching')>()),
  validateVoucherForInvoiceLink: mockValidateLink,
}))

import { tools } from '../server'

const markPaid = tools.find((t) => t.name === 'gnubok_mark_invoice_as_paid')!
const linkVoucher = tools.find((t) => t.name === 'gnubok_link_invoice_to_voucher')!

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'
const JE_ID = '44444444-4444-4444-8444-444444444444'

const SALE_ENTRY = {
  entry_date: '2026-09-01',
  description: 'Faktura F-1001',
  lines: [
    { account_number: '1510', debit_amount: 12500, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 10000, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 2500, line_description: null },
  ],
  total_debit: 12500,
  total_credit: 12500,
  balanced: true,
  note: 'n',
}

function unbookedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'F-1001',
    status: 'sent',
    document_type: 'invoice',
    credited_invoice_id: null,
    journal_entry_id: null,
    payment_cash_account_id: null,
    total: 12500,
    total_sek: 12500,
    subtotal: 10000,
    subtotal_sek: 10000,
    vat_amount: 2500,
    vat_amount_sek: 2500,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    paid_amount: 0,
    remaining_amount: 12500,
    customer: { id: 'cust-1', name: 'Testkund AB' },
    ...overrides,
  }
}

function setup(invoice: Record<string, unknown> = unbookedInvoice()) {
  return createTableMockSupabase({
    invoices: { data: invoice },
    invoice_items: { data: [] },
    company_settings: {
      data: {
        accounting_method: 'accrual',
        defer_invoice_booking: true,
        entity_type: 'aktiebolag',
        bookkeeping_locked_through: null,
      },
    },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
  })
}

const ACTOR = { type: 'api_key' } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockPlan.mockResolvedValue({ ok: true, required: false })
  mockValidateLink.mockResolvedValue({
    ok: true,
    arCreditAmount: 12500,
    arLineCurrency: 'SEK',
    voucher: {
      id: JE_ID,
      voucher_series: 'A',
      voucher_number: 7,
      entry_date: '2026-09-15',
      description: 'Inbetalning',
      status: 'posted',
      source_type: 'manual',
      fiscal_period_id: 'fp-1',
    },
    remainingAfter: 0,
    isFullyPaid: true,
    paymentAmount: 12500,
  })
})

describe('gnubok_mark_invoice_as_paid staging: sale first', () => {
  it('shows the sale verifikat approval books first, with the payment date as the settlement date', async () => {
    const { supabase, findCall } = setup()
    mockPlan.mockResolvedValue({ ok: true, required: true, invoiceId: INVOICE_ID, entry: SALE_ENTRY })

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { staged: boolean; preview: Record<string, unknown>; next?: { description: string } }

    expect(result.staged).toBe(true)
    expect(result.preview.books_sale_first).toBe(true)
    expect(result.preview.sale_entry).toEqual(SALE_ENTRY)
    expect(result.next?.description).toMatch(/sale verifikat books first/)
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ id: INVOICE_ID }),
      { settlementDate: '2026-09-15' },
    )
    expect(findCall('pending_operations', 'insert')).toBeDefined()
  })

  it('refuses at staging with the Bokför step code and stages nothing', async () => {
    const { supabase, findCall } = setup()
    mockPlan.mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_locked_at_set', invoice_date: '2026-09-01', sale_first: true, invoice_id: INVOICE_ID },
    })

    await expect(
      markPaid.execute({ invoice_id: INVOICE_ID, payment_date: '2026-09-15' }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED', details: { sale_first: true } })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('an invoice booked at issue stages as before, without sale fields', async () => {
    const { supabase } = setup(unbookedInvoice({ journal_entry_id: 'je-issue' }))

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { preview: Record<string, unknown>; next?: { description: string } }

    expect(result.preview).not.toHaveProperty('books_sale_first')
    expect(result.preview).not.toHaveProperty('sale_entry')
    expect(result.next?.description).toMatch(/booked when the invoice was issued/)
  })
})

describe('gnubok_link_invoice_to_voucher staging: sale first', () => {
  it('shows the sale verifikat approval books before the link', async () => {
    const { supabase, findCall } = setup()
    mockPlan.mockResolvedValue({ ok: true, required: true, invoiceId: INVOICE_ID, entry: SALE_ENTRY })

    const result = (await linkVoucher.execute(
      { invoice_id: INVOICE_ID, journal_entry_id: JE_ID },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { staged: boolean; preview: Record<string, unknown>; next?: { description: string } }

    expect(result.staged).toBe(true)
    expect(result.preview.books_sale_first).toBe(true)
    expect(result.preview.sale_entry).toEqual(SALE_ENTRY)
    expect(result.next?.description).toMatch(/sale verifikat is booked first/)
    // A link posts no payment entry: the plan checks no settlement date.
    expect(mockPlan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: INVOICE_ID }))
    expect(mockPlan.mock.calls[0]).toHaveLength(2)
    expect(findCall('pending_operations', 'insert')).toBeDefined()
  })

  it('refuses at staging with the Bokför step code and stages nothing', async () => {
    const { supabase, findCall } = setup()
    mockPlan.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_NO_FISCAL_PERIOD',
      details: { invoiceDate: '2026-09-01', sale_first: true, invoice_id: INVOICE_ID },
    })

    await expect(
      linkVoucher.execute({ invoice_id: INVOICE_ID, journal_entry_id: JE_ID }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'INVOICE_BOOK_NO_FISCAL_PERIOD' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('a link the validation refuses never plans the sale', async () => {
    const { supabase } = setup()
    mockValidateLink.mockResolvedValue({ ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' })

    await expect(
      linkVoucher.execute({ invoice_id: INVOICE_ID, journal_entry_id: JE_ID }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'LINK_VOUCHER_NO_AR_CREDIT' })
    expect(mockPlan).not.toHaveBeenCalled()
  })

  it('an invoice that needs nothing first stages as before', async () => {
    const { supabase } = setup(unbookedInvoice({ journal_entry_id: 'je-issue' }))

    const result = (await linkVoucher.execute(
      { invoice_id: INVOICE_ID, journal_entry_id: JE_ID },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { preview: Record<string, unknown>; next?: { description: string } }

    expect(result.preview).not.toHaveProperty('books_sale_first')
    expect(result.next?.description).toMatch(/No new verifikat is created/)
  })
})
