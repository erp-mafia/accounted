import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))

// The sale-first rule (defer_invoice_booking) has its own suites
// (lib/invoices/__tests__/sale-first.test.ts and the deferred-door tests);
// here no invoice needs its sale booked first.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planSaleBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  planSalesBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
}))
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: vi.fn(),
  createInvoiceCashEntry: vi.fn(),
  createInvoiceCashPartialEntry: vi.fn(),
  checkPriorCashRecognition: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: vi.fn(),
}))
// Mocked so it consumes no slot in the queued Supabase mock: the helper's own
// query shape is pinned by ./clear-settled-invoice-suggestions.test.ts.
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
// The override's own record is pinned by ./duplicate-guard-history.test.ts.
vi.mock('@/lib/invoices/duplicate-guard-history', () => ({
  recordInvoiceDuplicateGuardBypass: vi.fn(),
}))

import {
  checkPriorCashRecognition,
  createInvoiceCashEntry,
  createInvoiceCashPartialEntry,
  createInvoicePaymentJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { recordInvoiceDuplicateGuardBypass } from '@/lib/invoices/duplicate-guard-history'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { eventBus } from '@/lib/events'
import { ORE_TOLERANCE } from '@/lib/money'

function payableInvoice(overrides: Partial<Invoice> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', status: 'sent', total: 1250, currency: 'SEK' }),
    remaining_amount: 1250,
    paid_amount: 0,
    customer: { name: 'Kund AB' },
    ...overrides,
  } as Invoice & { customer?: { name?: string | null } | null }
}

const BASE_PARAMS = {
  settlementAccountNumber: '1930',
  paymentAmountInInvoiceCurrency: 1250,
  paymentDate: '2026-07-12',
  accountingMethod: 'accrual',
  entityType: 'aktiebolag' as const,
}

describe('settleInvoicePayment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue({ id: 'je-1' } as never)
    vi.mocked(createInvoiceCashEntry).mockResolvedValue({ id: 'je-2' } as never)
    vi.mocked(createInvoiceCashPartialEntry).mockResolvedValue({ id: 'je-3' } as never)
    vi.mocked(checkPriorCashRecognition).mockResolvedValue({ ok: true })
  })

  it('rejects credit notes before creating a journal entry or updating state', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice: payableInvoice({ credited_invoice_id: 'original-invoice-1' }),
      },
    )

    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_PAID_NOT_PAYABLE',
      details: { reason: 'credit_note' },
    })
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  // The doors are thin on purpose: a door that forgets to ask still gets the answer.
  describe('what a door did not ask', () => {
    it.each([
      ['a quote', { document_type: 'quote' }, '2026-03-30', 'INVOICE_QUOTE_NOT_PAYABLE'],
      ['a följesedel', { document_type: 'delivery_note' }, '2026-03-30', 'INVOICE_PAID_NOT_PAYABLE'],
      ['a paid invoice', { status: 'paid' }, '2026-03-30', 'INVOICE_PAID_NOT_PAYABLE'],
      ['a payment date ahead of today', {}, '2099-01-01', 'PAYMENT_DATE_IN_FUTURE'],
    ] as const)('refuses %s before anything is written', async (_label, overrides, paymentDate, code) => {
      const { supabase } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        invoice: makeInvoice({ status: 'sent', total: 1000, remaining_amount: 1000, ...overrides }) as Invoice,
        settlementAccountNumber: '1930',
        paymentAmountInInvoiceCurrency: 1000,
        paymentDate,
        accountingMethod: 'accrual',
        entityType: 'aktiebolag',
      })
      expect(result).toMatchObject({ ok: false, code })
      expect(createInvoicePaymentJournalEntry).not.toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('refuses an invoice with an active credit note, whichever door came', async () => {
      const { supabase } = createQueuedMockSupabase()
      mockHasActiveCreditNote.mockResolvedValueOnce(true)
      const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        invoice: makeInvoice({ status: 'sent', total: 1000, remaining_amount: 1000 }) as Invoice,
        settlementAccountNumber: '1930',
        paymentAmountInInvoiceCurrency: 1000,
        paymentDate: '2026-03-30',
        accountingMethod: 'accrual',
        entityType: 'aktiebolag',
        paymentSource: 'collections',
      })
      expect(result).toEqual({ ok: false, code: 'INVOICE_PAID_NOT_PAYABLE', details: { reason: 'active_credit_note' } })
      expect(createInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    })
  })

  it('records an overridden duplicate guard with the voucher it produced, on every door', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue({ id: 'je-1' } as never)
    enqueue({ data: { id: 'pay-1' } })
    enqueue({ data: [{ id: 'inv-1' }] })
    const actor = { user_id: 'user-1', actor_type: 'user' as const }

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      invoice: makeInvoice({
        id: 'inv-1',
        invoice_number: 'F-1',
        status: 'sent',
        total: 1000,
        remaining_amount: 1000,
        customer: { name: 'Kund AB' },
      } as never) as never,
      paymentAmountInInvoiceCurrency: 1000,
      paymentDate: '2026-03-30',
      accountingMethod: 'accrual',
      entityType: 'aktiebolag',
      settlementAccountNumber: '1931',
      duplicateGuardBypass: actor,
    })

    expect(result).toMatchObject({ ok: true, journalEntryId: 'je-1' })
    expect(vi.mocked(recordInvoiceDuplicateGuardBypass)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordInvoiceDuplicateGuardBypass).mock.calls[0][1]).toMatchObject({
      companyId: 'company-1',
      invoice: { id: 'inv-1', invoice_number: 'F-1', customer_name: 'Kund AB' },
      paymentAmount: 1000,
      paymentDate: '2026-03-30',
      paymentAccount: '1931',
      journalEntryId: 'je-1',
      actor,
    })
  })

  it('books via the payment entry and forwards the settlement account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const invoice = payableInvoice({ journal_entry_id: 'je-orig' } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice, settlementAccountNumber: '1686' },
    )

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-1' })
    expect(vi.mocked(createInvoicePaymentJournalEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      { ...invoice, carried_sek: null },
      '2026-07-12',
      undefined,
      'Kund AB',
      undefined,
      '1686',
      undefined,
      expect.any(Function),
    )
  })

  // Kontantmetoden partial payments: a never-booked invoice is booked one
  // pro-rata installment at a time (buildInvoiceCashPartialLines), never with
  // the whole-invoice cash entry against a smaller receipt.
  describe('kontantmetoden partial payments, CASH_PARTIAL_PAYMENTS_ENABLED unset', () => {
    // Off is the behaviour before the pro-rata rule: refused with the same
    // details, nothing booked, and the whole payment's update as it was.
    beforeEach(() => {
      vi.stubEnv('CASH_PARTIAL_PAYMENTS_ENABLED', '')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })
    const cashInvoice = (overrides: Partial<Invoice> = {}) =>
      payableInvoice({ journal_entry_id: null, subtotal: 1000, vat_amount: 250, ...overrides } as Partial<Invoice>)
    const CASH = { ...BASE_PARAMS, accountingMethod: 'cash' }

    it('refuses a first part payment exactly as before, booking nothing', async () => {
      const { supabase, findCalls } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...CASH,
        invoice: cashInvoice(),
        paymentAmountInInvoiceCurrency: 500,
        settlementAccountNumber: '1689',
        paymentSource: 'collections',
      })

      expect(result).toEqual({
        ok: false,
        code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
        details: { reason: 'partial_payment', payment_amount: 500, paid_amount: 0, invoice_total: 1250 },
      })
      expect(vi.mocked(createInvoiceCashPartialEntry)).not.toHaveBeenCalled()
      expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
      expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
      expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
      expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
      expect(findCalls('invoices', 'update')).toHaveLength(0)
    })

    it('refuses the completion of an earlier part payment without reading the ledger', async () => {
      const { supabase } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...CASH,
        invoice: cashInvoice({ status: 'partially_paid', paid_amount: 500, remaining_amount: 750 }),
        paymentAmountInInvoiceCurrency: 750,
        paymentSource: 'stripe',
      })

      expect(result).toEqual({
        ok: false,
        code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
        details: { reason: 'previously_partially_paid', payment_amount: 750, paid_amount: 500, invoice_total: 1250 },
      })
      expect(vi.mocked(checkPriorCashRecognition)).not.toHaveBeenCalled()
      expect(vi.mocked(createInvoiceCashPartialEntry)).not.toHaveBeenCalled()
      expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
    })

    it('books a whole payment with the whole-invoice entry and the update it always had', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // invoice_payments insert
      enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

      const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...CASH,
        invoice: cashInvoice(),
      })

      expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-2' })
      expect(vi.mocked(createInvoiceCashEntry)).toHaveBeenCalled()
      expect(vi.mocked(createInvoiceCashPartialEntry)).not.toHaveBeenCalled()
      expect(findCalls('invoices', 'or')).toEqual([])
      expect(findCalls('invoices', 'gt')).toEqual([])
      expect(findCalls('invoices', 'lt')).toEqual([])
    })
  })

  describe('kontantmetoden partial payments, CASH_PARTIAL_PAYMENTS_ENABLED set', () => {
    beforeEach(() => {
      vi.stubEnv('CASH_PARTIAL_PAYMENTS_ENABLED', '1')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })
    // 1 000 + 250 moms = 1 250 (header amounts; the builder's fallback path).
    const cashInvoice = (overrides: Partial<Invoice> = {}) =>
      payableInvoice({
        journal_entry_id: null,
        subtotal: 1000,
        vat_amount: 250,
        ...overrides,
      } as Partial<Invoice>)
    const CASH = { ...BASE_PARAMS, accountingMethod: 'cash' }
    // The CAS filter of a cash entry computed from paid_amount 0.
    const UNPAID_CAS = [
      `paid_amount.is.null,and(paid_amount.gt.${-ORE_TOLERANCE},paid_amount.lt.${ORE_TOLERANCE})`,
    ]

    function expectNothingBooked() {
      expect(vi.mocked(createInvoiceCashPartialEntry)).not.toHaveBeenCalled()
      expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
      expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
      expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
    }

    it("keeps a kontantfaktura under faktureringsmetoden full amount only: the pro-rata rule is kontantmetoden's", async () => {
      const { supabase } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...BASE_PARAMS,
        invoice: cashInvoice(),
        paymentAmountInInvoiceCurrency: 500,
        recognizeSaleAtPayment: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED' })
      expect((result as { details: Record<string, unknown> }).details).not.toHaveProperty('unsupported')
      expectNothingBooked()
    })

    it('books a first installment pro rata, never the whole-invoice entry', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // invoice_payments insert
      enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...CASH, invoice: cashInvoice(), paymentAmountInInvoiceCurrency: 500, settlementAccountNumber: '1689' },
      )

      expect(result).toMatchObject({ ok: true, newStatus: 'partially_paid', newPaidAmount: 500, journalEntryId: 'je-3' })
      expect(vi.mocked(createInvoiceCashPartialEntry)).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'inv-1',
        {
          description: 'Kontant delbetalning kundfaktura F-2024001, Kund AB',
          lines: [
            expect.objectContaining({ account_number: '1689', debit_amount: 500, credit_amount: 0 }),
            expect.objectContaining({ account_number: '3001', debit_amount: 0, credit_amount: 400 }),
            expect.objectContaining({ account_number: '2611', debit_amount: 0, credit_amount: 100 }),
          ],
        },
        '2026-07-12',
        // What the door saw, for the posting port (read only while POSTING_EVENTS is on).
        expect.any(Function),
      )
      // Nothing was paid before, so there is nothing in the ledger to check.
      expect(vi.mocked(checkPriorCashRecognition)).not.toHaveBeenCalled()
      expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
      expect(findCalls('invoice_payments', 'insert')[0][0]).toMatchObject({ amount: 500, journal_entry_id: 'je-3' })
      expect(findCalls('invoices', 'update').at(-1)?.[0]).toMatchObject({
        status: 'partially_paid',
        paid_amount: 500,
        remaining_amount: 750,
      })
      // The share was computed from paid_amount 0: the update only lands if
      // no other payment got there first.
      expect(findCalls('invoices', 'or')).toEqual([UNPAID_CAS])
    })

    it('loses the race when another payment moved paid_amount, cancelling its voucher', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-2' } }) // invoice_payments insert
      enqueue({ data: [] }) // CAS update matched nothing
      enqueue({ data: null }) // invoice_payments delete

      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        {
          ...CASH,
          invoice: cashInvoice({ status: 'partially_paid', paid_amount: 500, remaining_amount: 750 }),
          paymentAmountInInvoiceCurrency: 250,
        },
      )

      expect(result).toEqual({ ok: false, code: 'INVOICE_PAID_RACE' })
      // paid_amount still 500, within the half-öre band.
      expect(findCalls('invoices', 'gt')).toEqual([['paid_amount', 500 - ORE_TOLERANCE]])
      expect(findCalls('invoices', 'lt')).toEqual([['paid_amount', 500 + ORE_TOLERANCE]])
      expect(findCalls('invoice_payments', 'delete')).toHaveLength(1)
      expect(vi.mocked(cancelOrphanedPaymentEntry)).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'je-3',
        expect.any(String),
      )
    })

    it('guards a whole cash payment on an unpaid invoice the same way', async () => {
      // The whole-payment entry assumes nothing was paid. An installment that
      // landed between the read and this update has already recognised part
      // of the invoice, so the whole entry must lose the race, not book the
      // same revenue and moms a second time.
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // invoice_payments insert
      enqueue({ data: [] }) // CAS update matched nothing: paid_amount moved
      enqueue({ data: null }) // invoice_payments delete

      const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...CASH,
        invoice: cashInvoice(),
      })

      expect(vi.mocked(createInvoiceCashEntry)).toHaveBeenCalled()
      expect(findCalls('invoices', 'or')).toEqual([UNPAID_CAS])
      expect(result).toEqual({ ok: false, code: 'INVOICE_PAID_RACE' })
      expect(vi.mocked(cancelOrphanedPaymentEntry)).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'je-2',
        expect.any(String),
      )
    })

    it('leaves the CAS of a payment that clears a booked fordran as it was', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } })
      enqueue({ data: [{ id: 'inv-1' }] })

      await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...CASH,
        invoice: cashInvoice({ journal_entry_id: 'je-sale' } as Partial<Invoice>),
        paymentAmountInInvoiceCurrency: 500,
      })

      expect(vi.mocked(createInvoicePaymentJournalEntry)).toHaveBeenCalled()
      expect(findCalls('invoices', 'or')).toEqual([])
      expect(findCalls('invoices', 'gt')).toEqual([])
      expect(findCalls('invoices', 'lt')).toEqual([])
    })

    it('completes a part-paid invoice with the rest once the ledger shows the earlier installment', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-2' } })
      enqueue({ data: [{ id: 'inv-1' }] })

      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        {
          ...CASH,
          invoice: cashInvoice({ status: 'partially_paid', paid_amount: 500, remaining_amount: 750 }),
          paymentAmountInInvoiceCurrency: 750,
        },
      )

      expect(result).toMatchObject({ ok: true, newStatus: 'paid', newPaidAmount: 1250, newRemaining: 0 })
      expect(vi.mocked(checkPriorCashRecognition)).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'inv-1',
        500,
        { '3001': 400, '2611': 100 },
      )
      expect(vi.mocked(createInvoiceCashPartialEntry)).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'inv-1',
        {
          description: 'Kontant slutbetalning kundfaktura F-2024001, Kund AB',
          lines: [
            expect.objectContaining({ account_number: '1930', debit_amount: 750, credit_amount: 0 }),
            expect.objectContaining({ account_number: '3001', debit_amount: 0, credit_amount: 600 }),
            expect.objectContaining({ account_number: '2611', debit_amount: 0, credit_amount: 150 }),
          ],
        },
        '2026-07-12',
        // What the door saw, for the posting port (read only while POSTING_EVENTS is on).
        expect.any(Function),
      )
      expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
    })

    it('refuses the next installment when the earlier ones are not pro rata in the ledger', async () => {
      // E.g. a payment from before the guard that booked the whole invoice on
      // its first installment: booking the rest would count it twice.
      vi.mocked(checkPriorCashRecognition).mockResolvedValue({
        ok: false,
        reason: 'prior_payments_not_pro_rata',
        details: { accounts: [{ account: '3001', expected: 400, booked: 1000 }] },
      })
      const { supabase, findCalls } = createQueuedMockSupabase()

      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        {
          ...CASH,
          invoice: cashInvoice({ status: 'partially_paid', paid_amount: 500, remaining_amount: 750 }),
          paymentAmountInInvoiceCurrency: 750,
        },
      )

      expect(result).toMatchObject({
        ok: false,
        code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
        details: {
          reason: 'previously_partially_paid',
          unsupported: 'prior_payments_not_pro_rata',
          accounts: [{ account: '3001', expected: 400, booked: 1000 }],
        },
      })
      expectNothingBooked()
      expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
      expect(findCalls('invoices', 'update')).toHaveLength(0)
    })

    it('still refuses a partial with custom lines: they carry the whole-invoice shape', async () => {
      const { supabase } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        {
          ...CASH,
          invoice: cashInvoice(),
          paymentAmountInInvoiceCurrency: 500,
          customLines: [
            { account_number: '1930', debit_amount: 500, credit_amount: 0 },
            { account_number: '3001', debit_amount: 0, credit_amount: 400 },
            { account_number: '2611', debit_amount: 0, credit_amount: 100 },
          ],
        },
      )

      expect(result).toMatchObject({
        ok: false,
        code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
        details: { reason: 'partial_payment', unsupported: 'custom_lines' },
      })
      expectNothingBooked()
    })

    it.each([
      ['a ROT/RUT invoice', { deduction_total: 300, remaining_amount: 950 }, 'tax_deduction'],
      ['a foreign-currency invoice', { currency: 'EUR', exchange_rate: 11.5 }, 'foreign_currency'],
      ['lines that do not add up to the total', { subtotal: 900 }, 'lines_do_not_match_total'],
    ])('still refuses a partial of %s', async (_label, overrides, unsupported) => {
      const { supabase } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...CASH, invoice: cashInvoice(overrides as Partial<Invoice>), paymentAmountInInvoiceCurrency: 500 },
      )

      expect(result).toMatchObject({
        ok: false,
        code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
        details: { reason: 'partial_payment', unsupported },
      })
      expectNothingBooked()
    })

    it('refuses when remaining_amount and paid_amount disagree on what is owed', async () => {
      // The plan reads remaining_amount (500: this payment settles), the
      // builder total minus paid_amount (750: it does not). Flipping the
      // invoice to paid on a voucher that recognised 80 % of it would leave
      // the rest unrecognised for good.
      const { supabase } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        {
          ...CASH,
          invoice: cashInvoice({ status: 'partially_paid', paid_amount: 500, remaining_amount: 500 }),
          paymentAmountInInvoiceCurrency: 500,
        },
      )

      expect(result).toMatchObject({
        ok: false,
        code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
        details: { unsupported: 'remaining_mismatch' },
      })
      expectNothingBooked()
    })

    it('fails closed when no open period takes the installment', async () => {
      vi.mocked(createInvoiceCashPartialEntry).mockResolvedValue(null)
      const { supabase, findCalls } = createQueuedMockSupabase()
      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...CASH, invoice: cashInvoice(), paymentAmountInInvoiceCurrency: 500 },
      )

      expect(result).toMatchObject({
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: { reason: 'no_journal_entry_created' },
      })
      expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
      expect(findCalls('invoices', 'update')).toHaveLength(0)
    })
  })

  it('uses the cash entry for unbooked kontantmetoden invoices', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] })

    const invoice = payableInvoice({ journal_entry_id: null } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice, accountingMethod: 'cash', settlementAccountNumber: '1686' },
    )

    expect(result.ok).toBe(true)
    expect(vi.mocked(createInvoiceCashEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      invoice,
      '2026-07-12',
      'aktiebolag',
      'Kund AB',
      '1686',
      undefined,
      undefined,
      expect.any(Function),
      { deferDeductionShare: true },
    )
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
  })

  it('absorbs a sub-krona öresavrundning overshoot on SEK custom lines', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-ore' } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ok: true, sek: 1234.75 } }) // 1510 carries the remainder
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    // Invoice total 1234.75, PDF "Att betala" 1235.00: the customer pays the
    // rounded amount and the 3740 line carries the residual.
    const invoice = payableInvoice({
      total: 1234.75,
      remaining_amount: 1234.75,
      journal_entry_id: 'je-orig',
    } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        paymentAmountInInvoiceCurrency: 1235,
        customLines: [
          { account_number: '1930', debit_amount: 1235, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1234.75 },
          { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
        ],
      },
    )

    expect(result).toMatchObject({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 1234.75,
      newRemaining: 0,
      journalEntryId: 'je-ore',
    })
  })

  it('keeps a sub-krona short partial WITHOUT a 3740 line partially paid', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-partial' } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ok: true, sek: 1234.75 } }) // 1510 carries the remainder
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    // Deliberate partial: both legs lowered, no 3740. Absorbing here would
    // flip the invoice to paid while 1510 keeps the 0.75 residual.
    const invoice = payableInvoice({
      total: 1234.75,
      remaining_amount: 1234.75,
      journal_entry_id: 'je-orig',
    } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        paymentAmountInInvoiceCurrency: 1234,
        customLines: [
          { account_number: '1930', debit_amount: 1234, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1234 },
        ],
      },
    )

    expect(result).toMatchObject({
      ok: true,
      newStatus: 'partially_paid',
      newPaidAmount: 1234,
      newRemaining: 0.75,
    })
  })

  it('settles in full when the issue verifikat booked the öresavrundning and the lines clear what 1510 carries', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-issue-ore' } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The issue verifikat put 1510 at the rounded 1235 and Cr 3740 0.25.
    enqueue({ data: { ok: true, sek: 1235 } })
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const invoice = payableInvoice({
      total: 1234.75,
      remaining_amount: 1234.75,
      journal_entry_id: 'je-orig',
    } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        paymentAmountInInvoiceCurrency: 1235,
        customLines: [
          { account_number: '1930', debit_amount: 1235, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1235 },
        ],
      },
    )

    expect(supabase.rpc).toHaveBeenCalledWith('document_carried_sek', expect.objectContaining({ p_side: 'customer', p_document_id: invoice.id }))
    expect(result).toMatchObject({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 1234.75,
      newRemaining: 0,
      journalEntryId: 'je-issue-ore',
    })
  })

  it('rejects a sub-krona custom-line overshoot WITHOUT a 3740 line', async () => {
    const { supabase } = createQueuedMockSupabase()
    const invoice = payableInvoice({
      total: 1234.75,
      remaining_amount: 1234.75,
    } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        paymentAmountInInvoiceCurrency: 1235.25,
        customLines: [
          { account_number: '1930', debit_amount: 1235.25, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1235.25 },
        ],
      },
    )
    expect(result).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('rejects a custom-line overshoot beyond the öre band', async () => {
    const { supabase } = createQueuedMockSupabase()
    const invoice = payableInvoice({
      total: 1234.75,
      remaining_amount: 1234.75,
    } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        paymentAmountInInvoiceCurrency: 1236,
        customLines: [
          { account_number: '1930', debit_amount: 1236, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1236 },
        ],
      },
    )
    expect(result).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('does not absorb öre overshoot for non-SEK invoices', async () => {
    const { supabase } = createQueuedMockSupabase()
    const invoice = payableInvoice({
      total: 100,
      remaining_amount: 100,
      currency: 'EUR',
    } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        paymentAmountInInvoiceCurrency: 100.25,
        customLines: [
          { account_number: '1930', debit_amount: 100.25, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 100.25 },
        ],
      },
    )
    expect(result).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
  })

  it('rejects overpayment before creating any journal entry', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice: payableInvoice(), paymentAmountInInvoiceCurrency: 9999 },
    )
    expect(result).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
  })

  it('fails closed when no journal entry is produced', async () => {
    vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue(null)
    const { supabase } = createQueuedMockSupabase()
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice: payableInvoice() },
    )
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_BOOK_FAILED' })
  })

  it('cancels the orphaned voucher when the CAS update loses the race', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [] }) // CAS update matched nothing (concurrent settle)

    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice: payableInvoice() },
    )

    expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_RACE' })
    expect(vi.mocked(cancelOrphanedPaymentEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })

  // Issue #1259: a fully settled invoice must not keep sibling transactions
  // pointing at it as a match suggestion.
  it('retires the settled invoice suggestions when the invoice reaches paid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] })

    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice: payableInvoice() },
    )

    expect(result).toMatchObject({ ok: true, newStatus: 'paid' })
    expect(vi.mocked(clearSettledInvoiceSuggestions)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(clearSettledInvoiceSuggestions)).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'invoice',
      'inv-1',
    )
  })

  it('leaves the suggestions alone on a partial payment: the invoice is still matchable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] })

    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        paymentAmountInInvoiceCurrency: 500,
        invoice: payableInvoice(),
      },
    )

    expect(result).toMatchObject({ ok: true, newStatus: 'partially_paid' })
    expect(vi.mocked(clearSettledInvoiceSuggestions)).not.toHaveBeenCalled()
  })

  it('does not emit invoice.paid for a partial payment: money is still owed', async () => {
    const handler = vi.fn()
    eventBus.on('invoice.paid', handler)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] })

    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, paymentAmountInInvoiceCurrency: 500, invoice: payableInvoice() },
    )

    expect(result).toMatchObject({ ok: true, newStatus: 'partially_paid' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('emits invoice.paid with the settled state', async () => {
    const handler = vi.fn()
    eventBus.on('invoice.paid', handler)
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] })

    await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: payableInvoice(),
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        paymentAmount: 1250,
        invoice: expect.objectContaining({
          id: 'inv-1',
          status: 'paid',
          paid_at: '2026-07-12T12:00:00Z',
        }),
      }),
    )
    const invoiceUpdate = findCalls('invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({ paid_at: '2026-07-12T12:00:00Z' })
  })

  // Issue #2019: the manual and Stripe flows never wrote the AR sub-ledger
  // row, so the kontantmetod cut-off (which reads invoice_payments only)
  // booked a paid invoice as a fordran with vilande moms at bokslut.
  describe('invoice_payments row (#2019)', () => {
    it('records the payment in the sub-ledger with the voucher and no bank transaction', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // invoice_payments insert
      enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

      const invoice = payableInvoice({
        journal_entry_id: 'je-orig',
        exchange_rate: 1,
      } as Partial<Invoice>)
      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...BASE_PARAMS, invoice },
      )

      expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-1' })
      const inserts = findCalls('invoice_payments', 'insert')
      expect(inserts).toHaveLength(1)
      expect(inserts[0][0]).toEqual({
        user_id: 'user-1',
        company_id: 'company-1',
        invoice_id: 'inv-1',
        payment_date: '2026-07-12',
        amount: 1250,
        currency: 'SEK',
        exchange_rate: 1,
        journal_entry_id: 'je-1',
        transaction_id: null,
        notes: null,
        source: null,
        external_ref: null,
        // "Markera som betald": the payment voucher was created from the person's statement.
        link_basis: 'user_created',
        link_evidence: null,
      })
      expect(findCalls('invoice_payments', 'delete')).toHaveLength(0)
    })

    it('carries the payment source and outside reference to the row', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // invoice_payments insert
      enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched
      const invoice = payableInvoice({ journal_entry_id: 'je-orig', exchange_rate: 1 } as Partial<Invoice>)
      await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...BASE_PARAMS,
        invoice,
        paymentSource: 'stripe',
        externalRef: 'evt_123',
      })
      expect(findCalls('invoice_payments', 'insert')[0][0]).toMatchObject({
        source: 'stripe',
        external_ref: 'evt_123',
        // A payment sync pairs nothing by choice: system_derived, with its reference.
        link_basis: 'system_derived',
        link_evidence: { source_system: 'stripe', reference: 'evt_123' },
      })
    })

    it('clears what 1510 carries on a foreign invoice, read as the entry books', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { ok: true, sek: 1965.44 } }) // what 1510 carries
      enqueue({ data: { id: 'ip-1' } })
      enqueue({ data: [{ id: 'inv-1' }] })

      const invoice = payableInvoice({
        total: 176.7,
        remaining_amount: 176.7,
        currency: 'EUR',
        exchange_rate: 11.123,
        journal_entry_id: 'je-orig',
      } as Partial<Invoice>)
      await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
        ...BASE_PARAMS,
        invoice,
        paymentAmountInInvoiceCurrency: 176.7,
      })

      expect(supabase.rpc).toHaveBeenCalledWith('document_carried_sek', expect.objectContaining({ p_side: 'customer', p_document_id: invoice.id }))
      expect(vi.mocked(createInvoicePaymentJournalEntry).mock.calls.at(-1)?.[3]).toMatchObject({ carried_sek: 1965.44 })
    })

    it('stores a partial in invoice currency, not the SEK line total', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { ok: false, reason: 'no_registration_voucher' } }) // what 1510 carries
      enqueue({ data: { id: 'ip-1' } })
      enqueue({ data: [{ id: 'inv-1' }] })

      const invoice = payableInvoice({
        total: 1000,
        remaining_amount: 1000,
        currency: 'EUR',
        exchange_rate: 11.5,
        journal_entry_id: 'je-orig',
      } as Partial<Invoice>)
      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...BASE_PARAMS, invoice, paymentAmountInInvoiceCurrency: 400 },
      )

      expect(result).toMatchObject({ ok: true, newStatus: 'partially_paid', newRemaining: 600 })
      expect(findCalls('invoice_payments', 'insert')[0][0]).toMatchObject({
        amount: 400,
        currency: 'EUR',
        exchange_rate: 11.5,
        transaction_id: null,
      })
    })

    it('writes the row before the CAS update so the invoice never reaches paid without it', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: { code: '42501', message: 'rls' } }) // insert refused
      // Deliberately no CAS slot: the update must not run.

      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...BASE_PARAMS, invoice: payableInvoice() },
      )

      expect(result).toMatchObject({
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: { reason: 'payment_row_insert_failed', error: 'rls' },
      })
      expect(vi.mocked(cancelOrphanedPaymentEntry)).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'je-1',
        expect.any(String),
      )
    })

    it('removes the row together with the voucher when the CAS update loses the race', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // insert
      enqueue({ data: [] }) // CAS matched nothing
      enqueue({ data: null }) // delete

      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...BASE_PARAMS, invoice: payableInvoice() },
      )

      expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_RACE' })
      expect(findCalls('invoice_payments', 'delete')).toHaveLength(1)
      const deleteEqs = findCalls('invoice_payments', 'eq')
      expect(deleteEqs).toEqual(
        expect.arrayContaining([
          ['id', 'ip-1'],
          ['company_id', 'company-1'],
        ]),
      )
      expect(vi.mocked(cancelOrphanedPaymentEntry)).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['the CAS update loses the race', { data: [] }],
      ['the invoice update fails', { data: null, error: { message: 'update failed' } }],
    ])('cancels the voucher before it removes the row when %s (a collections row may only go once its voucher is cancelled)', async (_label, casResult) => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // insert
      enqueue(casResult)
      enqueue({ data: null }) // delete
      let deletesWhenCancelled = -1
      vi.mocked(cancelOrphanedPaymentEntry).mockImplementationOnce(async () => {
        deletesWhenCancelled = findCalls('invoice_payments', 'delete').length
        return true
      })

      await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...BASE_PARAMS, invoice: payableInvoice(), paymentSource: 'collections', externalRef: 'pay-1' },
      )

      expect(deletesWhenCancelled).toBe(0)
      expect(findCalls('invoice_payments', 'delete')).toHaveLength(1)
    })

    it('removes the row when the invoice update itself fails', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'ip-1' } }) // insert
      enqueue({ data: null, error: { message: 'update failed' } }) // CAS update error
      enqueue({ data: null }) // delete

      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...BASE_PARAMS, invoice: payableInvoice() },
      )

      expect(result).toMatchObject({ ok: false, code: 'UPDATE_FAILED' })
      expect(findCalls('invoice_payments', 'delete')).toHaveLength(1)
      expect(vi.mocked(cancelOrphanedPaymentEntry)).toHaveBeenCalledTimes(1)
    })

    it('skips the sub-ledger for non-invoice document types', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [{ id: 'inv-1' }] }) // CAS update only

      const invoice = payableInvoice({ document_type: 'proforma' } as Partial<Invoice>)
      const result = await settleInvoicePayment(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        { ...BASE_PARAMS, invoice },
      )

      expect(result).toMatchObject({ ok: true, journalEntryId: null })
      expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
    })
  })
})
