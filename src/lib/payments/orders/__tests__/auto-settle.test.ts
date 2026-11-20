/**
 * settleOrderWithDebit: the debit of a bank payment order books the supplier
 * payment as the user who approved the order, and the order is settled by the
 * payment row (the trigger) or by this code when the trigger's rule does not
 * reach the order. Every refusal is a refusal, never a throw.
 *
 * The booking runs for real down to the engine (createJournalEntry and
 * findFiscalPeriod are captured); the side-effect helpers pinned elsewhere are
 * mocked away so they consume no table answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { TargetPeriodLockedError } from '@/lib/bookkeeping/errors'
import type { CreateJournalEntryInput } from '@/types'

const mockCreateJournalEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({ anchorSupplierInvoiceDocument: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({ clearSettledInvoiceSuggestions: vi.fn() }))

// The registration-first planner (defer_invoice_booking) has its own suite;
// here it answers per test, by default "nothing to book first".
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  bookRegistrationBeforeSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryId: null,
    bookedHere: false,
    warnings: [],
  })),
}))

// The ledger duplicate guard runs for real (beforeEach); a test that needs a
// verifikat already booking the payment answers it here.
const mockDetectDuplicate = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-detection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  detectDuplicatePaymentVoucher: (...args: unknown[]) => mockDetectDuplicate(...args),
}))

import {
  bookRegistrationBeforeSettlement,
  planRegistrationBeforeSettlement,
} from '@/lib/supplier-invoices/registration-first'
import { loadOpenPaymentOrders, settleOrderWithDebit } from '../auto-settle'
import { ARCIM, arcimDebit, arcimInvoice, arcimOrder } from './fixtures'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
let db: ReturnType<typeof createTableMockSupabase>

type Line = { account_number: string; debit_amount: number; credit_amount: number }
const shape = (input: CreateJournalEntryInput | undefined) =>
  (input?.lines ?? []).map((l: Line) => [l.account_number, l.debit_amount, l.credit_amount])

function payload(table: string, method: 'insert' | 'update'): Record<string, unknown> | undefined {
  return db.findCall(table, method)?.[0] as Record<string, unknown> | undefined
}

async function settle(overrides: { confidence?: number; basis?: 'end_to_end_id' | 'amount_account_date' | 'payee' } = {}) {
  return settleOrderWithDebit(db.supabase as unknown as SupabaseClient, {
    order: { id: ARCIM.orderId, company_id: ARCIM.companyId },
    transaction: { id: ARCIM.transactionId },
    confidence: overrides.confidence ?? 0.98,
    basis: overrides.basis ?? 'payee',
    log,
  })
}

/** Every table answer the happy path reads, in call order; tests override what they change. */
function seed(options: { order?: Record<string, unknown>; linkedAfter?: boolean } = {}) {
  const order = arcimOrder(options.order)
  db = createTableMockSupabase({
    payment_orders: [
      { data: order }, // read again before booking
      { data: { id: order.id, status: order.status, supplier_invoice_payment_id: options.linkedAfter === false ? null : 'sip-1' } },
      { data: [{ id: order.id }] }, // the link, when this code writes it
    ],
    transactions: [{ data: arcimDebit() }, { data: [{ id: ARCIM.transactionId }] }], // read again, then the row claim
    supplier_invoices: [{ data: arcimInvoice() }, { data: [{ id: ARCIM.invoiceId }] }],
    company_settings: { data: { accounting_method: 'accrual' } },
    cash_accounts: { data: { ledger_account: '1930' } },
    supplier_invoice_payments: [{ data: { id: 'sip-9' } }],
    payment_match_log: { data: null },
    payment_order_events: { data: null },
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  const detection = await vi.importActual<typeof import('@/lib/invoices/duplicate-payment-detection')>(
    '@/lib/invoices/duplicate-payment-detection',
  )
  mockDetectDuplicate.mockImplementation(detection.detectDuplicatePaymentVoucher)
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-payment' })
  mockFindFiscalPeriod.mockResolvedValue('fp-2026')
  seed()
})

describe('settleOrderWithDebit', () => {
  it("books the Swedbank debit 0d1d0000 against order 40e40000's invoice as the user who approved the order, and the trigger settles the order", async () => {
    const result = await settle()

    expect(result).toEqual({ ok: true, journalEntryId: 'je-payment', orderLinked: true, linkedBy: 'trigger' })
    // The same clearing verifikat a person's confirm books: Dr 2440 / Cr 1930, 10,00.
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    const [, companyId, userId, input] = mockCreateJournalEntry.mock.calls[0] as [unknown, string, string, CreateJournalEntryInput]
    expect(companyId).toBe(ARCIM.companyId)
    expect(userId).toBe(ARCIM.userId)
    expect(shape(input)).toEqual([['2440', 10, 0], ['1930', 0, 10]])
    expect(input.entry_date).toBe('2026-10-13')
    // The ledger, the payment row the trigger keys on, and the link.
    expect(payload('supplier_invoices', 'update')).toMatchObject({
      status: 'paid', paid_amount: 10, remaining_amount: 0, payment_journal_entry_id: 'je-payment', transaction_id: ARCIM.transactionId,
    })
    expect(payload('supplier_invoice_payments', 'insert')).toMatchObject({
      user_id: ARCIM.userId, company_id: ARCIM.companyId, supplier_invoice_id: ARCIM.invoiceId,
      amount: 10, currency: 'SEK', transaction_id: ARCIM.transactionId, journal_entry_id: 'je-payment', payment_date: '2026-10-13',
    })
    expect(payload('transactions', 'update')).toMatchObject({
      supplier_invoice_id: ARCIM.invoiceId, potential_supplier_invoice_id: null, journal_entry_id: 'je-payment', is_business: true,
    })
    // The match log says the debit decided it, with the order and the confidence.
    expect(payload('payment_match_log', 'insert')).toMatchObject({
      user_id: ARCIM.userId,
      transaction_id: ARCIM.transactionId,
      supplier_invoice_id: ARCIM.invoiceId,
      action: 'auto_matched',
      match_method: 'payment_order',
      match_confidence: 0.98,
      new_state: expect.objectContaining({ status: 'paid', payment_order_id: ARCIM.orderId, confidence: 0.98, matched_by: 'payee' }),
    })
    // The trigger linked the order: nothing to write on it.
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
  })

  it('links an order the bank has not reported executed yet itself, with an event that says the debit decided it', async () => {
    seed({ order: { status: 'accepted', executed_at: null, provider_status: 'ACSP' }, linkedAfter: false })

    const result = await settle({ confidence: 0.95, basis: 'amount_account_date' })

    expect(result).toEqual({ ok: true, journalEntryId: 'je-payment', orderLinked: true, linkedBy: 'debit' })
    const link = payload('payment_orders', 'update')
    expect(link).toMatchObject({
      status: 'executed',
      supplier_invoice_payment_id: 'sip-9',
      matched_transaction_id: ARCIM.transactionId,
      matched_at: expect.any(String),
      executed_at: expect.any(String),
    })
    // Compare-and-set on the status read and on nobody having linked it meanwhile.
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'accepted'])
    expect(db.findCalls('payment_orders', 'is')).toContainEqual(['supplier_invoice_payment_id', null])
    const [events] = db.findCall('payment_order_events', 'insert') as [Array<Record<string, unknown>>]
    expect(events).toEqual([
      expect.objectContaining({
        payment_order_id: ARCIM.orderId,
        event_type: 'matched',
        from_status: 'accepted',
        to_status: 'executed',
        actor_user_id: null,
        detail: { supplier_invoice_payment_id: 'sip-9', transaction_id: ARCIM.transactionId, by: 'debit', matched_by: 'amount_account_date', confidence: 0.95 },
      }),
    ])
  })

  it('keeps the bank\'s executed_at when it links an executed order whose payment row the trigger did not take (öre apart)', async () => {
    seed({ linkedAfter: false })

    const result = await settle()

    expect(result).toMatchObject({ ok: true, linkedBy: 'debit' })
    expect(payload('payment_orders', 'update')).not.toHaveProperty('executed_at', expect.any(String))
  })

  it('refuses when the order was settled meanwhile, booking nothing', async () => {
    db.setTable('payment_orders', { data: arcimOrder({ supplier_invoice_payment_id: 'sip-earlier' }) })

    expect(await settle()).toEqual({ ok: false, reason: 'order_not_open' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(db.findCalls('supplier_invoices', 'update')).toEqual([])
  })

  it('refuses when the debit was booked, linked or ignored meanwhile', async () => {
    db.setTable('transactions', { data: arcimDebit({ journal_entry_id: 'je-elsewhere' }) })
    expect(await settle()).toEqual({ ok: false, reason: 'transaction_not_open' })

    seed()
    db.setTable('transactions', { data: arcimDebit({ supplier_invoice_id: 'inv-elsewhere' }) })
    expect(await settle()).toEqual({ ok: false, reason: 'transaction_not_open' })

    seed()
    db.setTable('transactions', { data: arcimDebit({ is_ignored: true }) })
    expect(await settle()).toEqual({ ok: false, reason: 'transaction_not_open' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a debit booked only through a voucher link (a samlingsverifikat), booking nothing (accounted#58)', async () => {
    // The pointer is empty, so the read above lets it through; the booking's
    // own gate sees the bank_line link to a posted verifikat.
    db.setTable('transaction_voucher_links', { data: [{ journal_entry_id: 'je-samling', role: 'bank_line' }] })
    db.setTable('journal_entries', {
      data: [{ id: 'je-samling', status: 'posted', source_type: 'manual', source_id: null, voucher_series: 'A', voucher_number: 40 }],
    })

    expect(await settle()).toEqual({
      ok: false,
      reason: 'booking_failed',
      code: 'MATCH_SI_TX_ALREADY_BOOKED',
      details: { journal_entry_id: 'je-samling', voucher: 'A40', via: 'link', storno_allowed: false },
    })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(db.findCalls('supplier_invoices', 'update')).toEqual([])
    expect(db.findCalls('transactions', 'update')).toEqual([])
  })

  it('leaves a debit a verifikat already books to a person: no force, nothing written (accounted#58)', async () => {
    // The payment booked by hand while the invoice stayed open: the debit of
    // the signed order must not book it a second time with no one looking.
    const candidate = {
      journal_entry_id: 'je-by-hand', voucher_label: 'A31', entry_date: '2026-10-13', description: null,
      amount: 10, bank_account_number: '1930', reason: 'exact_amount_same_date', amount_verified: true, unverified_reason: null,
    }
    mockDetectDuplicate.mockResolvedValueOnce(candidate)

    expect(await settle()).toEqual({
      ok: false,
      reason: 'booking_failed',
      code: 'MATCH_SI_POSSIBLE_DUPLICATE',
      details: { candidate },
    })
    expect(mockDetectDuplicate).toHaveBeenCalledWith(db.supabase, expect.objectContaining({
      companyId: ARCIM.companyId, transactionId: ARCIM.transactionId,
    }), { skipClaimed: true })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(db.findCalls('supplier_invoices', 'update')).toEqual([])
    expect(db.findCalls('transactions', 'update')).toEqual([])
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
  })

  it('refuses amounts apart: an end-to-end match of another amount stays a suggestion for a person', async () => {
    db.setTable('transactions', { data: arcimDebit({ amount: -9.5, end_to_end_id: ARCIM.endToEndId }) })

    expect(await settle({ confidence: 0.99, basis: 'end_to_end_id' })).toMatchObject({ ok: false, reason: 'amount_mismatch' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses an invoice that is no longer open for the order\'s amount', async () => {
    db.setTable('supplier_invoices', { data: arcimInvoice({ status: 'paid', remaining_amount: 0, paid_amount: 10 }) })
    expect(await settle()).toMatchObject({ ok: false, reason: 'invoice_not_matchable' })

    seed()
    db.setTable('supplier_invoices', { data: arcimInvoice({ status: 'partially_paid', remaining_amount: 5, paid_amount: 5 }) })
    expect(await settle()).toMatchObject({ ok: false, reason: 'invoice_not_matchable' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('falls back when the booking is refused before any write: no open period for the debit date', async () => {
    mockFindFiscalPeriod.mockResolvedValue(null)

    expect(await settle()).toEqual({
      ok: false,
      reason: 'booking_failed',
      code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
      details: { paymentDate: '2026-10-13' },
    })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(db.findCalls('supplier_invoices', 'update')).toEqual([])
  })

  it('falls back when the engine refuses a locked period, with its code', async () => {
    mockCreateJournalEntry.mockRejectedValue(new TargetPeriodLockedError('2026-10-13', '2026-10-31'))

    expect(await settle()).toMatchObject({ ok: false, reason: 'booking_failed', code: 'TARGET_PERIOD_LOCKED' })
    expect(db.findCalls('supplier_invoices', 'update')).toEqual([])
    expect(db.findCalls('supplier_invoice_payments', 'insert')).toEqual([])
  })

  it('never throws: an unexpected failure is a refusal', async () => {
    db.supabase.from.mockImplementationOnce(() => {
      throw new Error('connection reset')
    })

    expect(await settle()).toEqual({ ok: false, reason: 'booking_failed', code: 'UNEXPECTED_ERROR' })
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('loadOpenPaymentOrders', () => {
  it('reads the signed, unmatched orders of the company created within the lookback, and drops what the read filter would', async () => {
    db.setTable('payment_orders', {
      data: [arcimOrder(), arcimOrder({ id: 'settled', supplier_invoice_payment_id: 'sip-1' }), arcimOrder({ id: 'unsent', provider_payment_id: null })],
    })

    const orders = await loadOpenPaymentOrders(db.supabase as unknown as SupabaseClient, ARCIM.companyId, new Date('2026-10-13T12:00:00Z'))

    expect(orders.map((o) => o.id)).toEqual([ARCIM.orderId])
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['company_id', ARCIM.companyId])
    // The settleable statuses and awaiting_signature, for an order without an
    // invoice whose signing finished while the bank still answers RCVD (link-by-debit.test.ts).
    expect(db.findCalls('payment_orders', 'in')).toContainEqual(['status', ['awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed']])
    expect(db.findCalls('payment_orders', 'is')).toContainEqual(['supplier_invoice_payment_id', null])
    expect(db.findCalls('payment_orders', 'not')).toContainEqual(['provider_payment_id', 'is', null])
    expect(db.findCalls('payment_orders', 'gte')).toEqual([['created_at', '2026-08-14T12:00:00.000Z']])
  })

  it('answers an empty list when the read fails', async () => {
    db.setTable('payment_orders', { data: null, error: { message: 'boom' } })
    expect(await loadOpenPaymentOrders(db.supabase as unknown as SupabaseClient, ARCIM.companyId)).toEqual([])
  })
})

describe('settleOrderWithDebit: a block (Spärr) on what the settlement books (accounted#145)', () => {
  const block = (overrides: Record<string, unknown>) => ({
    id: 'r-1', rule_id: 'r-1', version: 1, accounts: null, counterparty_key: null, counterparty_label: null,
    amount_from_sek: null, vat_treatment: null, note: null, valid_from: '2026-10-29T00:00:00Z', created_by: 'u-1',
    created_at: '2026-10-29T00:00:00Z', revoked_at: null, revoked_by: null, revoked_reason: null, ...overrides,
  })

  it('leaves an unbooked invoice a block may hold to a person, without drafting a verifikat', async () => {
    db.setTable('booking_review_rules', { data: [block({ counterparty_key: 'exempel systems', counterparty_label: 'Exempel Systems AB' })] })
    db.setTable('supplier_invoices', { data: arcimInvoice({ registration_journal_entry_id: null }) })
    expect(await settle()).toEqual({ ok: false, reason: 'booking_review_rule' })
    seed()
    db.setTable('booking_review_rules', { data: [block({ accounts: ['6540'] })] })
    db.setTable('supplier_invoices', { data: arcimInvoice({ registration_journal_entry_id: null }) })
    expect(await settle()).toEqual({ ok: false, reason: 'booking_review_rule' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('settles as before when the invoice is booked already, or no block names it', async () => {
    db.setTable('booking_review_rules', { data: [block({ accounts: ['6540'] })] })
    expect((await settle()).ok).toBe(true)
    seed()
    db.setTable('booking_review_rules', { data: [block({ accounts: ['5410'] })] })
    db.setTable('supplier_invoices', [{ data: arcimInvoice({ registration_journal_entry_id: null }) }, { data: [{ id: ARCIM.invoiceId }] }])
    expect(await settle()).not.toEqual({ ok: false, reason: 'booking_review_rule' })
  })
})

describe('settleOrderWithDebit: a deferring company whose invoice is not booked yet', () => {
  const requiredPlan = {
    ok: true as const,
    required: true as const,
    supplierInvoiceId: ARCIM.invoiceId,
    entry: {
      entry_date: '2026-10-01',
      description: 'Leverantörsfaktura',
      lines: [
        { account_number: '6540', debit_amount: 8, credit_amount: 0, line_description: null },
        { account_number: '2641', debit_amount: 2, credit_amount: 0, line_description: null },
        { account_number: '2440', debit_amount: 0, credit_amount: 10, line_description: null },
      ],
      total_debit: 10,
      total_credit: 10,
      balanced: true,
      note: '',
    },
    payableSek: 10,
    createsAccrualSchedules: false,
  }

  it('books the registration first, as the user who approved the order, then the 2440 clearing', async () => {
    vi.mocked(planRegistrationBeforeSettlement).mockResolvedValueOnce(requiredPlan)
    vi.mocked(bookRegistrationBeforeSettlement).mockResolvedValueOnce({
      ok: true,
      journalEntryId: 'je-registration',
      bookedHere: true,
      warnings: [],
    })

    const result = await settle()

    expect(result).toMatchObject({ ok: true, journalEntryId: 'je-payment' })
    expect(vi.mocked(planRegistrationBeforeSettlement)).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: ARCIM.companyId, userId: ARCIM.userId }),
      expect.objectContaining({ id: ARCIM.invoiceId }),
      { settlementDate: '2026-10-13' },
    )
    const bookOrder = vi.mocked(bookRegistrationBeforeSettlement).mock.invocationCallOrder[0]
    expect(bookOrder).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
    const input = mockCreateJournalEntry.mock.calls[0][3] as CreateJournalEntryInput
    expect(shape(input)).toEqual([['2440', 10, 0], ['1930', 0, 10]])
  })

  it('a refused registration leaves the order for a person: booking_failed with the Bokför code, nothing written', async () => {
    vi.mocked(planRegistrationBeforeSettlement).mockResolvedValueOnce({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { invoice_date: '2026-09-30', registration_first: true, supplier_invoice_id: ARCIM.invoiceId },
    })

    const result = await settle()

    expect(result).toEqual({
      ok: false,
      reason: 'booking_failed',
      code: 'PERIOD_LOCKED',
      details: expect.objectContaining({ registration_first: true }),
    })
    expect(vi.mocked(bookRegistrationBeforeSettlement)).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(db.findCalls('supplier_invoices', 'update')).toEqual([])
    expect(db.findCalls('supplier_invoice_payments', 'insert')).toEqual([])
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
  })
})
