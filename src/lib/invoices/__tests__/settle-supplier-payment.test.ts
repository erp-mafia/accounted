/**
 * "Markera som betald" for a supplier invoice: the one definition behind the
 * dashboard POST, its preview and the v1 POST. What used to differ per door is
 * pinned here once, against the definition, and each door keeps a test that it
 * still asks (route.test.ts in both mark-paid folders, preview/route.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeSupplier, makeSupplierInvoice } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const mocks = vi.hoisted(() => ({
  signed: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  lock: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ locked: false })),
  duplicates: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  bypass: vi.fn(async (..._args: unknown[]) => undefined),
  paymentEntry: vi.fn(),
  cashEntry: vi.fn(),
  cancel: vi.fn(async (..._args: unknown[]) => undefined),
  clear: vi.fn(async (..._args: unknown[]) => undefined),
  anchor: vi.fn(async (..._args: unknown[]) => null),
  paidEvent: vi.fn(async (..._args: unknown[]) => 'emitted'),
  planRegistration: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, required: false })),
  bookRegistration: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    ok: true,
    journalEntryId: null,
    bookedHere: false,
    warnings: [],
  })),
}))

vi.mock('@/lib/payments/orders/signed-payment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/orders/signed-payment')>()),
  findSignedBankPayment: (...args: unknown[]) => mocks.signed(...args),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: (...args: unknown[]) => mocks.lock(...args) }))
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForSupplierInvoice: (...args: unknown[]) => mocks.duplicates(...args),
}))
vi.mock('@/lib/invoices/duplicate-guard-history', () => ({
  recordSupplierInvoiceDuplicateGuardBypass: (...args: unknown[]) => mocks.bypass(...args),
}))
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: (...args: unknown[]) => mocks.paymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) => mocks.cashEntry(...args),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: (...args: unknown[]) => mocks.cancel(...args),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: (...args: unknown[]) => mocks.clear(...args),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: (...args: unknown[]) => mocks.anchor(...args),
}))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitSupplierInvoicePaidIfSettled: (...args: unknown[]) => mocks.paidEvent(...args),
}))
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationBeforeSettlement: (...args: unknown[]) => mocks.planRegistration(...args),
  bookRegistrationBeforeSettlement: (...args: unknown[]) => mocks.bookRegistration(...args),
}))

import {
  bookSupplierSettlement,
  planSupplierSettlement,
  supplierSettlementInput,
  type SettleableSupplierInvoice,
  type SupplierSettlementInput,
} from '../settle-supplier-payment'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as unknown as Logger
const USER_ACTOR = { user_id: 'user-1', actor_type: 'user' as const }

function invoice(overrides: Record<string, unknown> = {}): SettleableSupplierInvoice {
  return makeSupplierInvoice({
    id: 'si-1',
    status: 'partially_paid',
    currency: 'SEK',
    total: 2440,
    paid_amount: 1440,
    remaining_amount: 1000,
    registration_journal_entry_id: 'je-reg',
    supplier: makeSupplier({ name: 'Leverantör AB' }),
    items: [],
    ...overrides,
  }) as unknown as SettleableSupplierInvoice
}

function client() {
  const mock = createQueuedMockSupabase()
  return { ...mock, ctx: { supabase: mock.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log } }
}

async function plan(si: SettleableSupplierInvoice, input: SupplierSettlementInput, accountingMethod = 'accrual') {
  const db = client()
  db.enqueue({ data: { accounting_method: accountingMethod, last_supplier_payment_account: '1931' } })
  return { db, outcome: await planSupplierSettlement(db.ctx, si, input) }
}

async function planned(si: SettleableSupplierInvoice, input: SupplierSettlementInput) {
  const { db, outcome } = await plan(si, input)
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`)
  return { db, plan: outcome.plan }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.paymentEntry.mockResolvedValue({ id: 'je-pay' })
  mocks.cashEntry.mockResolvedValue({ id: 'je-cash' })
})

describe('planSupplierSettlement: what every door refuses', () => {
  it('an amount above what is owed: 1500 on a remaining 1000 clears nothing', async () => {
    const { outcome, db } = await plan(invoice(), { amount: 1500, paymentDate: '2026-05-12' })

    expect(outcome).toEqual({
      ok: false,
      code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING',
      details: { transaction_amount: 1500, remaining_amount: 1000, excess: 500 },
    })
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('takes the half öre a rounded amount can carry, never a whole one', async () => {
    expect((await plan(invoice(), { amount: 1000.004, paymentDate: '2026-05-12' })).outcome).toMatchObject({ ok: true })
    expect((await plan(invoice(), { amount: 1000.01, paymentDate: '2026-05-12' })).outcome).toMatchObject({
      ok: false,
      code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING',
    })
  })

  it('a whole-krona amount above an öre total: öre belong on 3740 in the rows, not on 2440', async () => {
    const { outcome } = await plan(invoice({ total: 533.75, paid_amount: 0, remaining_amount: 533.75 }), {
      amount: 534,
      paymentDate: '2026-05-12',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING' })
  })

  it('a credit note', async () => {
    const { outcome } = await plan(invoice({ is_credit_note: true, status: 'registered' }), { amount: 500 })
    expect(outcome).toEqual({ ok: false, code: 'SI_PAID_NOT_PAYABLE', details: { reason: 'credit_note' } })
  })

  it.each(['paid', 'credited', 'reversed'])('an invoice already %s', async (status) => {
    const { outcome } = await plan(invoice({ status }), {})
    expect(outcome).toEqual({ ok: false, code: 'SI_PAID_ALREADY', details: { current_status: status } })
  })

  it('a status that was never payable', async () => {
    const { outcome } = await plan(invoice({ status: 'draft' }), {})
    expect(outcome).toEqual({ ok: false, code: 'SI_PAID_NOT_PAYABLE', details: { current_status: 'draft' } })
  })

  it('a payment date ahead of today', async () => {
    const { outcome } = await plan(invoice(), { paymentDate: '2099-01-01' })
    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_DATE_IN_FUTURE', details: { attempted: '2099-01-01' } })
  })

  it('a signed bank payment, force or no force: the bank still pays it', async () => {
    mocks.signed.mockResolvedValueOnce({ id: 'order-1', status: 'accepted', requested_execution_date: '2026-10-30' })

    const { outcome } = await plan(invoice(), { force: true, paymentDate: '2026-05-12' })

    expect(outcome).toEqual({
      ok: false,
      code: 'SI_BANK_PAYMENT_UNDER_WAY',
      details: { payment_order_id: 'order-1', payment_order_status: 'accepted', requested_execution_date: '2026-10-30' },
    })
  })

  it('a locked period, before the registration or the voucher', async () => {
    mocks.lock.mockResolvedValueOnce({ locked: true, reason: 'period_is_closed', fiscal_period_id: 'fp-1' })

    const { outcome } = await plan(invoice(), { paymentDate: '2026-05-12' })

    expect(outcome).toEqual({
      ok: false,
      code: 'SI_PAID_PERIOD_LOCKED',
      details: { reason: 'period_is_closed', fiscal_period_id: 'fp-1', payment_date: '2026-05-12' },
    })
    expect(mocks.planRegistration).not.toHaveBeenCalled()
  })

  it('kontantmetoden: a partial of a never-booked invoice, the cash entry books all of it', async () => {
    const { outcome } = await plan(
      invoice({ registration_journal_entry_id: null, paid_amount: 0, total: 1000 }),
      { amount: 400, paymentDate: '2026-05-12' },
      'cash',
    )
    expect(outcome).toMatchObject({ ok: false, code: 'SI_CASH_PARTIAL_UNSUPPORTED' })
  })

  it('edited rows that do not balance', async () => {
    const { outcome } = await plan(invoice(), {
      paymentDate: '2026-05-12',
      lines: [
        { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 900 },
      ],
    })
    expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_PAID_LINES_UNBALANCED' })
  })
})

describe('planSupplierSettlement: the plan', () => {
  it('the rest of a part-paid invoice settles it', async () => {
    const { plan: p } = await planned(invoice(), { paymentDate: '2026-05-12' })
    expect(p).toMatchObject({
      paymentAmount: 1000,
      newPaidAmount: 2440,
      newRemaining: 0,
      newStatus: 'paid',
      paidAt: '2026-05-12T12:00:00Z',
      clearingSek: 1000,
      useCashEntry: false,
      lastPaymentAccount: '1931',
    })
  })

  it('a part payment leaves the rest open and no paid_at', async () => {
    const { plan: p } = await planned(invoice(), { amount: 400, paymentDate: '2026-05-12' })
    expect(p).toMatchObject({ newPaidAmount: 1840, newRemaining: 600, newStatus: 'partially_paid', paidAt: null })
  })

  it('the duplicate guard is the last word, on a full settlement only', async () => {
    mocks.duplicates.mockResolvedValueOnce([{ id: 'tx-1' }])
    expect((await plan(invoice(), { paymentDate: '2026-05-12' })).outcome).toEqual({
      ok: false,
      code: 'SI_PAID_LIKELY_DUPLICATE',
      details: { candidates: [{ id: 'tx-1' }] },
    })

    vi.clearAllMocks()
    await planned(invoice(), { amount: 400, paymentDate: '2026-05-12' })
    expect(mocks.duplicates).not.toHaveBeenCalled()
  })

  it('force overrides the guard only where the guard had something to say', async () => {
    expect((await planned(invoice(), { force: true, paymentDate: '2026-05-12' })).plan.overridesDuplicateGuard).toBe(true)
    expect(mocks.duplicates).not.toHaveBeenCalled()
    expect((await planned(invoice(), { force: true, amount: 400, paymentDate: '2026-05-12' })).plan.overridesDuplicateGuard).toBe(false)
  })

  it('writes nothing', async () => {
    const { db } = await planned(invoice(), { paymentDate: '2026-05-12' })
    for (const method of ['insert', 'update', 'delete']) expect(db.findCalls('supplier_invoices', method)).toEqual([])
    expect(mocks.paymentEntry).not.toHaveBeenCalled()
    expect(mocks.bookRegistration).not.toHaveBeenCalled()
  })
})

describe('bookSupplierSettlement: one write path', () => {
  async function book(input: SupplierSettlementInput = { paymentDate: '2026-05-12' }, si = invoice()) {
    const { plan: p } = await planned(si, input)
    const db = client()
    return { db, book: (replies: Array<{ data?: unknown; error?: unknown }>) => {
      replies.forEach((r) => db.enqueue(r as never))
      return bookSupplierSettlement(db.ctx, p, USER_ACTOR)
    } }
  }

  it('books the voucher, then the row, then the status, and only then what follows', async () => {
    const { db, book: run } = await book()

    const result = await run([{ data: { id: 'pay-1' } }, { data: [{ id: 'si-1' }] }])

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', newPaidAmount: 2440, newRemaining: 0, journalEntryId: 'je-pay' })
    expect((db.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'supplier_invoice_payments',
      'supplier_invoices',
    ])
    expect(db.findCalls('supplier_invoice_payments', 'insert')[0][0]).toMatchObject({
      amount: 1000,
      journal_entry_id: 'je-pay',
      link_basis: 'user_created',
    })
    expect(db.findCalls('supplier_invoices', 'update')[0][0]).toEqual({
      status: 'paid',
      remaining_amount: 0,
      paid_amount: 2440,
      paid_at: '2026-05-12T12:00:00Z',
      payment_journal_entry_id: 'je-pay',
    })
    // The compare-and-set: a part payment since the plan read the invoice loses too.
    expect(db.findCalls('supplier_invoices', 'eq')).toContainEqual(['paid_amount', 1440])
    expect(mocks.clear).toHaveBeenCalledWith(expect.anything(), 'company-1', 'supplier_invoice', 'si-1')
    expect(mocks.anchor).toHaveBeenCalledWith(expect.anything(), 'company-1', 'si-1')
    expect(mocks.paidEvent).toHaveBeenCalledWith(
      expect.objectContaining({ newStatus: 'paid', paymentAmount: 1000, supplierInvoice: expect.objectContaining({ status: 'paid', paid_amount: 2440, remaining_amount: 0 }) }),
    )
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('a row that cannot be written: the voucher is cancelled and the invoice never moved', async () => {
    const { db, book: run } = await book()

    const result = await run([{ data: null, error: { message: 'insert failed' } }])

    expect(result).toEqual({ ok: false, code: 'SI_PAID_FAILED', details: { reason: 'payment_record_insert_failed' } })
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1', 'je-pay',
      'Automatiskt makulerad: betalningspost kunde inte registreras',
    )
    expect(db.findCalls('supplier_invoices', 'update')).toEqual([])
    expect(mocks.paidEvent).not.toHaveBeenCalled()
  })

  it('a lost race: the voucher goes first, then the row, and the winner stands', async () => {
    const { db, book: run } = await book()

    const result = await run([{ data: { id: 'pay-1' } }, { data: [] }, { data: null }])

    expect(result).toEqual({ ok: false, code: 'SI_PAID_ALREADY', details: { reason: 'race' } })
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1', 'je-pay',
      'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
    )
    expect(db.findCalls('supplier_invoice_payments', 'delete')).toHaveLength(1)
    expect(mocks.paidEvent).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('a failed status update: the same way out', async () => {
    const { db, book: run } = await book()

    const result = await run([{ data: { id: 'pay-1' } }, { data: null, error: { message: 'update failed' } }, { data: null }])

    expect(result).toEqual({ ok: false, code: 'SI_PAID_FAILED', details: { reason: 'si_update_failed' } })
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(db.findCalls('supplier_invoice_payments', 'delete')).toHaveLength(1)
  })

  it('a helper that posts nothing: no row, no status', async () => {
    mocks.paymentEntry.mockResolvedValue(null)
    const { db, book: run } = await book()

    expect(await run([])).toEqual({ ok: false, code: 'SI_PAID_FAILED', details: { reason: 'no_journal_entry_created' } })
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('names a registration it booked first when the payment then fails: that verifikat stands', async () => {
    mocks.bookRegistration.mockResolvedValueOnce({ ok: true, journalEntryId: 'je-reg-new', bookedHere: true, warnings: [] })
    const { book: run } = await book()

    expect(await run([{ data: null, error: { message: 'insert failed' } }])).toEqual({
      ok: false,
      code: 'SI_PAID_FAILED',
      details: { reason: 'payment_record_insert_failed', registration_journal_entry_id: 'je-reg-new' },
    })
  })

  it('a refused registration refuses the payment before any voucher', async () => {
    mocks.bookRegistration.mockResolvedValueOnce({ ok: false, code: 'SI_BOOK_FAILED', details: { registration_first: true } })
    const { book: run } = await book()

    expect(await run([])).toMatchObject({ ok: false, code: 'SI_BOOK_FAILED' })
    expect(mocks.paymentEntry).not.toHaveBeenCalled()
  })

  it('kontantmetoden books the cash entry with the SEK that left the account', async () => {
    const si = invoice({ registration_journal_entry_id: null, currency: 'USD', paid_amount: 0, total: 1000 })
    const { outcome } = await plan(si, { paymentDate: '2026-05-12', amountSek: 9500 }, 'cash')
    if (!outcome.ok) throw new Error(outcome.code)
    const db = client()
    db.enqueue({ data: { id: 'pay-1' } })
    db.enqueue({ data: [{ id: 'si-1' }] })

    await bookSupplierSettlement(db.ctx, outcome.plan, USER_ACTOR)

    expect(mocks.cashEntry).toHaveBeenCalledTimes(1)
    expect(mocks.cashEntry.mock.calls[0][9]).toBe(9500)
    expect(mocks.paymentEntry).not.toHaveBeenCalled()
  })

  it('the override goes in the behandlingshistorik once the voucher exists, a partial has none', async () => {
    const forced = await book({ paymentDate: '2026-05-12', force: true, paymentAccount: '1931' })
    await forced.book([{ data: { id: 'pay-1' } }, { data: [{ id: 'si-1' }] }])
    expect(mocks.bypass).toHaveBeenCalledTimes(1)
    expect(mocks.bypass.mock.calls[0][1]).toMatchObject({
      journalEntryId: 'je-pay',
      paymentAmount: 1000,
      paymentAccount: '1931',
      actor: USER_ACTOR,
    })

    vi.clearAllMocks()
    mocks.paymentEntry.mockResolvedValue({ id: 'je-pay' })
    const partial = await book({ paymentDate: '2026-05-12', force: true, amount: 400 })
    await partial.book([{ data: { id: 'pay-1' } }, { data: [{ id: 'si-1' }] }])
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
})

describe('supplierSettlementInput', () => {
  it('reads a request body the way both POST doors do', () => {
    expect(
      supplierSettlementInput({ amount: 100, payment_date: '2026-05-12', amount_sek: 90, payment_account: '1931', notes: 'n', force: true }),
    ).toEqual({
      amount: 100,
      paymentDate: '2026-05-12',
      amountSek: 90,
      exchangeRateDifference: undefined,
      paymentAccount: '1931',
      lines: undefined,
      notes: 'n',
      force: true,
    })
  })
})
