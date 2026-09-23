import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: vi.fn(),
  createInvoiceCashEntry: vi.fn(),
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

import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { eventBus } from '@/lib/events'

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
      invoice,
      '2026-07-12',
      undefined,
      'Kund AB',
      undefined,
      '1686',
    )
  })

  it('rejects a cash-method partial payment on a never-booked invoice before booking anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    const invoice = payableInvoice({ journal_entry_id: null } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        accountingMethod: 'cash',
        paymentAmountInInvoiceCurrency: 500,
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
      details: { reason: 'partial_payment' },
    })
    // The full-invoice cash entry must never book against a partial receipt,
    // and no invoice state may change.
    expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('rejects completing a previously part-paid never-booked cash invoice (would double-book the total)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const invoice = payableInvoice({
      status: 'partially_paid',
      journal_entry_id: null,
      remaining_amount: 750,
      paid_amount: 500,
    } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      {
        ...BASE_PARAMS,
        invoice,
        accountingMethod: 'cash',
        paymentAmountInInvoiceCurrency: 750,
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
      details: { reason: 'previously_partially_paid' },
    })
    expect(vi.mocked(createInvoiceCashEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
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
    )
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
  })

  it('absorbs a sub-krona öresavrundning overshoot on SEK custom lines', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-ore' } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
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
      })
      expect(findCalls('invoice_payments', 'delete')).toHaveLength(0)
    })

    it('stores a partial in invoice currency, not the SEK line total', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
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
