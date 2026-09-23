/**
 * The 19xx-credit (`bank_credit`) side of the supplier voucher matcher: a
 * kontantmetod company's invoice with no registration verifikat (issue #2854).
 *
 * The side itself is decided by the DB function
 * supplier_invoice_settlement_side and pinned in
 * tests/pg/link-supplier-invoice-voucher-kontantmetod.pg.test.ts; here the
 * lookup is stubbed to answer `bank_credit`, and what is pinned is that the
 * matcher and the pre-stage validator FOLLOW that answer: the account prefix
 * and ledger column they read, the amount band, and the capacity rule. The
 * 244x-debit side stays in supplier-voucher-matching.test.ts, unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  validateVoucherForSupplierInvoiceLink,
  findMatchingVouchersForSupplierInvoice,
} from '../supplier-voucher-matching'
import { makeSupplierInvoice, createQueuedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'

const BANK_CREDIT = { side: 'bank_credit', accountPrefix: '19', entrySide: 'credit' } as const

const { mockResolveSide } = vi.hoisted(() => ({ mockResolveSide: vi.fn() }))
vi.mock('@/lib/invoices/supplier-settlement-side', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supplier-settlement-side')>()
  return { ...actual, resolveSupplierSettlementSide: mockResolveSide }
})

vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))

const voucher = (over: Partial<{ source_type: string | null; status: string }> = {}) => ({
  id: 'je-1',
  voucher_series: 'A',
  voucher_number: 12,
  entry_date: '2026-04-28',
  description: 'Betalning Leverantor AB',
  status: over.status ?? 'posted',
  source_type: over.source_type === undefined ? 'bank_transaction' : over.source_type,
  fiscal_period_id: 'fp-1',
  company_id: 'company-1',
})

/** Kontantmetoden: the cost and the ingående moms against the bank account. */
const cashPaymentLines = (total: number) => [
  { account_number: '4010', debit_amount: total * 0.8, credit_amount: 0, currency: 'SEK' },
  { account_number: '2641', debit_amount: total * 0.2, credit_amount: 0, currency: 'SEK' },
  { account_number: '1930', debit_amount: 0, credit_amount: total, currency: 'SEK' },
]

const sekInvoice = (remaining = 1250, total = remaining) =>
  makeSupplierInvoice({
    id: 'si-1',
    total,
    paid_amount: roundOre(total - remaining),
    remaining_amount: remaining,
    currency: 'SEK',
  })

describe('validateVoucherForSupplierInvoiceLink: bank_credit side', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSide.mockResolvedValue(BANK_CREDIT)
  })

  async function validate(
    invoice: ReturnType<typeof makeSupplierInvoice>,
    queue: Array<{ data?: unknown; error?: unknown }>,
  ) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany(queue)
    return validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
  }

  it('accepts the bank-first payment verifikat: Dr cost, Dr 2641 / Cr 1930, no 244x line', async () => {
    const result = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: cashPaymentLines(1250) },
      { data: [] }, // payment rows on the voucher (capacity)
      { data: [] }, // already linked to this invoice?
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.settlementSide).toBe('bank_credit')
      expect(result.apDebitAmount).toBe(1250)
      expect(result.paymentAmount).toBe(1250)
      expect(result.isFullyPaid).toBe(true)
    }
    expect(mockResolveSide).toHaveBeenCalledWith(expect.anything(), 'company-1', 'si-1')
  })

  it('reads the CREDIT column only: money coming back into 19xx is not a payment', async () => {
    const result = await validate(sekInvoice(1250), [
      { data: voucher() },
      {
        data: [
          { account_number: '1930', debit_amount: 1250, credit_amount: 0, currency: 'SEK' },
          { account_number: '4010', debit_amount: 0, credit_amount: 1250, currency: 'SEK' },
        ],
      },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_NO_BANK_CREDIT')
  })

  it('names the bank side when the voucher type is excluded', async () => {
    const result = await validate(sekInvoice(1250), [{ data: voucher({ source_type: 'storno' }) }])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_NO_BANK_CREDIT')
      expect(result.details).toEqual({ source_type: 'storno' })
    }
  })

  it('records a smaller payout as a partial payment', async () => {
    const result = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: cashPaymentLines(500) },
      { data: [] },
      { data: [] },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(500)
      expect(result.remainingAfter).toBe(750)
      expect(result.isFullyPaid).toBe(false)
    }
  })

  it('refuses a payout larger than the remainder, and says which side it read', async () => {
    const result = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: cashPaymentLines(5000) },
      { data: [] },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
      expect(result.details).toEqual({ bank_credit: 5000, remaining: 1250 })
    }
  })

  it('refuses a voucher whose payout another invoice has already used (the recurring-invoice trap)', async () => {
    const result = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: cashPaymentLines(1250) },
      {
        data: [
          { journal_entry_id: 'je-1', supplier_invoice_id: 'si-last-month', amount: 1250, currency: 'SEK' },
        ],
      },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_FULLY_ALLOCATED')
      expect(result.details).toEqual({ bank_credit: 1250, already_linked: 1250 })
    }
  })

  it('settles with what the payout has left after other invoices rows', async () => {
    const result = await validate(sekInvoice(4000), [
      { data: voucher() },
      { data: cashPaymentLines(10000) },
      {
        data: [
          { journal_entry_id: 'je-1', supplier_invoice_id: 'si-other', amount: 6000, currency: 'SEK' },
        ],
      },
      { data: [] },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.apDebitAmount).toBe(4000)
      expect(result.paymentAmount).toBe(4000)
      expect(result.isFullyPaid).toBe(true)
    }
  })

  it("leaves this invoice's own row to the already-linked guard", async () => {
    const ownRow = { journal_entry_id: 'je-1', supplier_invoice_id: 'si-1', amount: 500, currency: 'SEK' }
    const result = await validate(sekInvoice(750, 1250), [
      { data: voucher() },
      { data: cashPaymentLines(500) },
      { data: [ownRow] },
      { data: [{ id: 'sip-1' }] },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_ALREADY_LINKED')
  })

  it('refuses a voucher whose rows are in another currency: the used part is unreadable', async () => {
    const result = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: cashPaymentLines(1250) },
      {
        data: [
          { journal_entry_id: 'je-1', supplier_invoice_id: 'si-eur', amount: 100, currency: 'EUR' },
        ],
      },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
      expect(result.details?.reason).toBe('voucher_settles_other_currency')
    }
  })

  describe('a foreign invoice paid by a plain kronor voucher', () => {
    const eurInvoice = () =>
      makeSupplierInvoice({
        id: 'si-1',
        total: 100,
        paid_amount: 0,
        remaining_amount: 100,
        currency: 'EUR',
        exchange_rate: 11.5,
      })

    it('settles the full remaining (no residual to book: that is the RPC side, and it books none)', async () => {
      const result = await validate(eurInvoice(), [
        { data: voucher() },
        { data: cashPaymentLines(1180) },
        { data: [] },
        { data: [] },
      ])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.paymentAmount).toBe(100)
        expect(result.isFullyPaid).toBe(true)
      }
    })

    it('refuses when the kronor voucher already carries a row for another invoice', async () => {
      const result = await validate(eurInvoice(), [
        { data: voucher() },
        { data: cashPaymentLines(1180) },
        {
          data: [
            { journal_entry_id: 'je-1', supplier_invoice_id: 'si-other', amount: 100, currency: 'EUR' },
          ],
        },
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('LINK_SI_VOUCHER_FULLY_ALLOCATED')
        expect(result.details).toEqual({ linked_rows: 1 })
      }
    })

    it('still refuses a kronor voucher far off the invoice value', async () => {
      const result = await validate(eurInvoice(), [
        { data: voucher() },
        { data: cashPaymentLines(100) },
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
        expect(result.details?.reason).toBe('fx_deviation_too_large')
      }
    })
  })
})

describe('findMatchingVouchersForSupplierInvoice: bank_credit side', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSide.mockResolvedValue(BANK_CREDIT)
  })

  const entry = (id: string, description = 'Betalning Leverantor AB') => ({
    id,
    voucher_series: 'A',
    voucher_number: 42,
    entry_date: '2026-04-28',
    description,
    status: 'posted',
    source_type: 'bank_transaction',
    fiscal_period_id: 'period-1',
  })

  const bankLine = (entryId: string, credit: number) => ({
    id: `line-${entryId}`,
    journal_entry_id: entryId,
    account_number: '1930',
    debit_amount: 0,
    credit_amount: credit,
    currency: 'SEK',
  })

  const invoice = () =>
    makeSupplierInvoice({
      id: 'si-1',
      total: 1250,
      paid_amount: 0,
      remaining_amount: 1250,
      currency: 'SEK',
      due_date: '2026-05-01',
      supplier_invoice_number: 'F-9001',
    })

  it('searches 19xx credits inside the amount band, and offers the payout as the candidate', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: [entry('je-1')] },
      { data: [bankLine('je-1', 1250)] },
      { data: [] }, // payment rows on the candidate vouchers
      { data: [{ id: 'period-1', is_closed: false, locked_at: null }] },
    ])

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    expect(findCalls('journal_entry_lines', 'like')).toEqual([['account_number', '19%']])
    expect(findCalls('journal_entry_lines', 'gt')).toEqual([['credit_amount', 0]])
    // candidateAmountBand(1250, 1250): ±(1% + 0.02).
    expect(findCalls('journal_entry_lines', 'gte')).toEqual([['credit_amount', 1237.48]])
    expect(findCalls('journal_entry_lines', 'lte')).toEqual([['credit_amount', 1262.52]])
    // Capacity reads every row on the voucher, not only this invoice's.
    expect(findCalls('supplier_invoice_payments', 'eq')).toEqual([['company_id', 'company-1']])

    expect(result).toHaveLength(1)
    expect(result[0].journal_entry_id).toBe('je-1')
    expect(result[0].settlement_side).toBe('bank_credit')
    expect(result[0].ap_debit_amount).toBe(1250)
  })

  it("does not offer last month's payment of the same amount for this month's invoice", async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [entry('je-used'), entry('je-free')] },
      { data: [bankLine('je-used', 1250), bankLine('je-free', 1250)] },
      {
        data: [
          { journal_entry_id: 'je-used', supplier_invoice_id: 'si-last-month', amount: 1250, currency: 'SEK' },
        ],
      },
      { data: [{ id: 'period-1', is_closed: false, locked_at: null }] },
    ])

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    expect(result.map((c) => c.journal_entry_id)).toEqual(['je-free'])
  })

  it('takes a side the caller already resolved instead of looking it up again', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    await findMatchingVouchersForSupplierInvoice(supabase as never, 'company-1', invoice() as never, {
      settlementSide: BANK_CREDIT,
    })

    expect(mockResolveSide).not.toHaveBeenCalled()
  })
})
