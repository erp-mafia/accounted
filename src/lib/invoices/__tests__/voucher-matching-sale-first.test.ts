/**
 * linkInvoiceToVoucher (lib/invoices/voucher-matching.ts) and the sale-first
 * rule (lib/invoices/sale-first.ts): a deferring company's invoice sent
 * without its verifikat gets its sale booked by the Bokför step before the
 * link_invoice_to_voucher RPC records the existing voucher as its payment.
 * The link is validated first, so neither a link refusal nor a Bokför
 * refusal writes anything. The rule itself is stubbed (it has its own suite).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockPlanById, mockBookSale } = vi.hoisted(() => ({
  mockPlanById: vi.fn(),
  mockBookSale: vi.fn(),
}))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlementById: mockPlanById,
  bookSaleBeforeSettlement: mockBookSale,
}))

vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/core/documents/customer-invoice-underlag', () => ({
  anchorCustomerInvoiceDocument: vi.fn(),
}))
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  autoReconcileTransactionForLinkedVoucher: vi.fn(async () => null),
}))

import { linkInvoiceToVoucher } from '../voucher-matching'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const SALE_ENTRY = {
  entry_date: '2026-05-02',
  description: 'Faktura F-7',
  lines: [
    { account_number: '1510', debit_amount: 1000, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 800, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 200, line_description: null },
  ],
  total_debit: 1000,
  total_credit: 1000,
  balanced: true,
  note: 'n',
}
const REQUIRED_PLAN = { ok: true, required: true, invoiceId: 'inv-1', entry: SALE_ENTRY }

const UNBOOKED_INVOICE = {
  id: 'inv-1',
  invoice_number: 'F-7',
  status: 'sent',
  document_type: 'invoice',
  credited_invoice_id: null,
  currency: 'SEK',
  total: 1000,
  paid_amount: 0,
  remaining_amount: 1000,
  due_date: '2026-06-01',
  paid_at: null,
  exchange_rate: null,
  journal_entry_id: null,
  customer_id: 'cust-1',
  customer: { id: 'cust-1', name: 'Kund AB' },
}

// invoice_settlement_side for a faktureringsmetoden invoice (supabase.rpc
// consumes a queue slot like a table read).
const AR_CREDIT_ROW = { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }

/** The link_invoice_to_voucher calls (the settlement side is an rpc too). */
type RpcMock = { rpc: { mock: { calls: unknown[][]; invocationCallOrder: number[] } } }
const linkRpcCalls = (supabase: RpcMock) =>
  supabase.rpc.mock.calls.filter(([fn]) => fn === 'link_invoice_to_voucher')
const linkRpcOrder = (supabase: RpcMock) =>
  supabase.rpc.mock.invocationCallOrder[supabase.rpc.mock.calls.findIndex(([fn]) => fn === 'link_invoice_to_voucher')]!

/** The reads of validateVoucherForInvoiceLink for a voucher that credits 1510. */
function enqueueValidLink(enqueue: (r: { data?: unknown; error?: unknown }) => void, credit = 1000) {
  enqueue({ data: AR_CREDIT_ROW }) // invoice_settlement_side
  enqueue({
    data: {
      id: 'je-pay',
      voucher_series: 'A',
      voucher_number: 9,
      entry_date: '2026-05-20',
      description: 'Inbetalning',
      status: 'posted',
      source_type: 'manual',
      fiscal_period_id: 'fp-1',
      company_id: 'company-1',
    },
  })
  enqueue({
    data: [
      { account_number: '1930', debit_amount: credit, credit_amount: 0, currency: 'SEK' },
      { account_number: '1510', debit_amount: 0, credit_amount: credit, currency: 'SEK' },
    ],
  })
  enqueue({ data: [] }) // invoice_payments rows on the voucher (capacity)
  enqueue({ data: [] }) // invoice_payments already-linked lookup
}

function enqueueRpcOk(enqueue: (r: { data?: unknown; error?: unknown }) => void, status: 'paid' | 'partially_paid') {
  enqueue({
    data: {
      ok: true,
      payment_id: 'pay-1',
      invoice_status: status,
      paid_amount: status === 'paid' ? 1000 : 400,
      remaining_amount: status === 'paid' ? 0 : 600,
      payment_amount: status === 'paid' ? 1000 : 400,
      journal_entry_id: 'je-pay',
      currency: 'SEK',
      payment_date: '2026-05-20',
    },
    error: null,
  })
  enqueue({ data: null, error: null }) // post-link invoice re-fetch
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockPlanById.mockResolvedValue({ ok: true, required: false })
  mockBookSale.mockResolvedValue({ ok: true, journalEntryId: 'je-sale', bookedHere: true, warnings: [] })
})

describe('linkInvoiceToVoucher: sale first (defer_invoice_booking)', () => {
  it('validates the link, books the sale, then records the voucher as the payment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)
    enqueue({ data: UNBOOKED_INVOICE }) // the invoice the validation reads
    enqueueValidLink(enqueue)
    enqueueRpcOk(enqueue, 'paid')

    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-pay',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.saleJournalEntryId).toBe('je-sale')
    expect(mockPlanById).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), 'inv-1')
    expect(mockBookSale).toHaveBeenCalledWith(expect.anything(), REQUIRED_PLAN)
    expect(mockBookSale.mock.invocationCallOrder[0]!).toBeLessThan(linkRpcOrder(supabase))
  })

  it('books the sale before a partial payment link too', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)
    enqueue({ data: UNBOOKED_INVOICE })
    enqueueValidLink(enqueue, 400)
    enqueueRpcOk(enqueue, 'partially_paid')

    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-pay',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.invoiceStatus).toBe('partially_paid')
      expect(result.result.saleJournalEntryId).toBe('je-sale')
    }
    expect(mockBookSale).toHaveBeenCalledTimes(1)
  })

  it('a link the validation refuses books no sale and never calls the RPC', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)
    enqueue({ data: UNBOOKED_INVOICE })
    enqueue({ data: AR_CREDIT_ROW }) // invoice_settlement_side
    enqueue({ data: null, error: null }) // the voucher does not exist

    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-missing',
    })

    expect(result).toEqual({ ok: false, code: 'LINK_VOUCHER_VOUCHER_NOT_FOUND', details: undefined })
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(linkRpcCalls(supabase)).toEqual([])
  })

  it('a Bokför refusal at planning answers its code with details.sale_first and writes nothing', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockPlanById.mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_is_closed', invoice_date: '2025-12-20', sale_first: true, invoice_id: 'inv-1' },
    })

    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-pay',
    })

    expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED', details: { sale_first: true } })
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('a Bokför refusal at booking answers its code (a typed error by its own code) and never calls the RPC', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_FAILED',
      error: Object.assign(new Error('Konto saknas'), { code: 'ACCOUNTS_NOT_IN_CHART' }),
      details: { sale_first: true, invoice_id: 'inv-1' },
    })
    enqueue({ data: UNBOOKED_INVOICE })
    enqueueValidLink(enqueue)

    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-pay',
    })

    expect(result).toMatchObject({ ok: false, code: 'ACCOUNTS_NOT_IN_CHART', details: { sale_first: true } })
    expect(linkRpcCalls(supabase)).toEqual([])
  })

  it('an invoice that needs nothing first (booked at issue, kontantmetoden) links as before', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRpcOk(enqueue, 'paid')

    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-pay',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.saleJournalEntryId).toBeNull()
    expect(mockBookSale).not.toHaveBeenCalled()
    // No extra invoice read: the RPC is the first call.
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
})
