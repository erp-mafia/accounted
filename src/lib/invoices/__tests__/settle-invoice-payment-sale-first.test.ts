/**
 * settleInvoicePayment books the sale first for a deferring company's unbooked
 * invoice (faktureringsmetoden with defer_invoice_booking): the Bokför step
 * posts Debit 1510 / Credit revenue + utgående moms on the invoice date, and
 * only then does the payment clear 1510. A refusal of the Bokför step (or a
 * locked payment date) refuses the payment with nothing written.
 *
 * The real sale-first module runs; the Bokför step (bookInvoice), the period
 * lock verdict and the entry generators are mocked the way
 * ./settle-invoice-payment.test.ts mocks them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'

vi.mock('@/lib/invoices/book-service', () => ({ bookInvoice: vi.fn() }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn() }))
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
// Mocked so it consumes no slot in the queued Supabase mock.
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))

import { bookInvoice } from '@/lib/invoices/book-service'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { eventBus } from '@/lib/events'

const DEFERRING = { accounting_method: 'accrual', defer_invoice_booking: true }
const KONTANT = { accounting_method: 'cash', defer_invoice_booking: false }

const SALE_ENTRY = {
  entry_date: '2026-09-10',
  description: 'Kundfaktura F-1042',
  lines: [
    { account_number: '1510', debit_amount: 1250, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 1000, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 250, line_description: null },
  ],
  total_debit: 1250,
  total_credit: 1250,
  balanced: true,
  note: 'preview',
}

function unbookedInvoice(overrides: Partial<Invoice> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', status: 'sent', total: 1250, currency: 'SEK' }),
    journal_entry_id: null,
    document_type: 'invoice',
    credited_invoice_id: null,
    remaining_amount: 1250,
    paid_amount: 0,
    customer: { name: 'Kund AB' },
    ...overrides,
  } as Invoice & { customer?: { name?: string | null } | null }
}

const BASE_PARAMS = {
  settlementAccountNumber: '1930',
  paymentAmountInInvoiceCurrency: 1250,
  paymentDate: '2026-10-12',
  accountingMethod: 'accrual',
  entityType: 'aktiebolag' as const,
}

/** The Bokför step: a dry run previews the sale, the real call books it. */
function bokforBooks(journalEntryId = 'je-sale') {
  vi.mocked(bookInvoice).mockImplementation(async (_ctx, invoiceId, options) => {
    if (options?.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: { invoice_id: invoiceId, journal_entry: SALE_ENTRY },
      }
    }
    return { ok: true, data: { invoice: { id: invoiceId } as Invoice, journal_entry_id: journalEntryId }, warnings: [] }
  })
}

const realBookCalls = () => vi.mocked(bookInvoice).mock.calls.filter((call) => !call[2]?.dryRun)

describe('settleInvoicePayment: the sale first for a deferring company', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, fiscal_period_id: 'fp-pay' })
    vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue({ id: 'je-pay' } as never)
    vi.mocked(createInvoiceCashEntry).mockResolvedValue({ id: 'je-cash' } as never)
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-custom' } as never)
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-pay')
    bokforBooks()
  })

  it('books the sale through the Bokför step, then clears 1510 with the payment', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan)
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const paid = vi.fn()
    eventBus.on('invoice.paid', paid)

    const invoice = unbookedInvoice()
    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice,
    })

    expect(result).toMatchObject({
      ok: true,
      newStatus: 'paid',
      journalEntryId: 'je-pay',
      saleJournalEntryId: 'je-sale',
      warnings: [],
    })
    // The payment date is checked, the dry run plans, the real step books.
    expect(checkPeriodLock).toHaveBeenCalledWith(expect.anything(), 'company-1', '2026-10-12')
    expect(vi.mocked(bookInvoice).mock.calls.map((call) => call[2])).toEqual([{ dryRun: true }, undefined])
    // The sale is booked BEFORE the payment.
    const realBook = vi.mocked(bookInvoice).mock.invocationCallOrder[1]!
    const payment = vi.mocked(createInvoicePaymentJournalEntry).mock.invocationCallOrder[0]!
    expect(realBook).toBeLessThan(payment)
    // The payment is the 1510 clearing, never the kontantmetoden cash entry.
    expect(createInvoiceCashEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_payments', 'insert')).toHaveLength(1)
    // invoice.paid carries the verifikat the invoice now has.
    expect(paid).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: expect.objectContaining({ journal_entry_id: 'je-sale', status: 'paid' }) }),
    )
  })

  it('refuses the payment with the Bokför code and writes nothing when Bokför refuses', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'company_lock_date_covers', invoice_date: '2026-01-15' },
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan)

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: unbookedInvoice(),
    })

    expect(result).toEqual({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: {
          reason: 'company_lock_date_covers',
          invoice_date: '2026-01-15',
          sale_first: true,
          invoice_id: 'inv-1',
        },
      },
    })
    expect(realBookCalls()).toHaveLength(0)
    expect(createInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('refuses a locked payment date before the Bokför step runs at all', async () => {
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-9' })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan)

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: unbookedInvoice(),
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: { code: 'PERIOD_LOCKED', details: { payment_date: '2026-10-12', sale_first: true } },
    })
    expect(bookInvoice).not.toHaveBeenCalled()
    expect(createInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('books the sale, then a partial payment from custom clearing lines', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan)
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: unbookedInvoice(),
      paymentAmountInInvoiceCurrency: 500,
      customLines: [
        { account_number: '1930', debit_amount: 500, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 500 },
      ],
    })

    expect(result).toMatchObject({
      ok: true,
      newStatus: 'partially_paid',
      newPaidAmount: 500,
      newRemaining: 750,
      journalEntryId: 'je-custom',
      saleJournalEntryId: 'je-sale',
    })
    expect(realBookCalls()).toHaveLength(1)
    const realBook = vi.mocked(bookInvoice).mock.invocationCallOrder[1]!
    const payment = vi.mocked(createJournalEntry).mock.invocationCallOrder[0]!
    expect(realBook).toBeLessThan(payment)
    expect(vi.mocked(createJournalEntry).mock.calls[0]![3]).toMatchObject({
      source_type: 'invoice_paid',
      entry_date: '2026-10-12',
    })
  })

  it('books no sale for custom lines that book the revenue themselves (no 151x credit)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: unbookedInvoice(),
      customLines: [
        { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 250 },
      ],
    })

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-custom', saleJournalEntryId: null })
    expect(bookInvoice).not.toHaveBeenCalled()
    expect(checkPeriodLock).not.toHaveBeenCalled()
  })

  it('never calls Bokför for an invoice booked at issue', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: unbookedInvoice({ journal_entry_id: 'je-issue' } as Partial<Invoice>),
    })

    expect(result).toMatchObject({ ok: true, journalEntryId: 'je-pay', saleJournalEntryId: null })
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('never calls Bokför under kontantmetoden: the cash entry books the sale at payment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: KONTANT, error: null }) // company_settings (the plan)
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      accountingMethod: 'cash',
      invoice: unbookedInvoice(),
    })

    expect(result).toMatchObject({ ok: true, journalEntryId: 'je-cash', saleJournalEntryId: null })
    expect(bookInvoice).not.toHaveBeenCalled()
    expect(createInvoiceCashEntry).toHaveBeenCalledTimes(1)
    expect(createInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('books no sale first for a kontantfaktura paid at issue: its cash entry books the sale', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    // A deferring company issues the invoice already paid (crm#1281): the
    // one cash verifikat is the sale and the payment, no 1510 leg.
    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      paymentDate: '2026-09-10',
      invoice: unbookedInvoice(),
      recognizeSaleAtPayment: true,
    })

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-cash', saleJournalEntryId: null })
    expect(bookInvoice).not.toHaveBeenCalled()
    expect(checkPeriodLock).not.toHaveBeenCalled()
    expect(createInvoiceCashEntry).toHaveBeenCalledTimes(1)
    expect(createInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('books no sale for a proforma, which carries no verifikat at all', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: unbookedInvoice({ document_type: 'proforma' } as Partial<Invoice>),
    })

    expect(result).toMatchObject({ ok: true, journalEntryId: null, saleJournalEntryId: null })
    expect(bookInvoice).not.toHaveBeenCalled()
  })
})

/**
 * A sale booked first that books the öresavrundning (1510 at the rounded "Att
 * betala" 1 000, the 0,25 on 3740, as the issue of an öre invoice books it)
 * leaves 1 000 on 1510 while the reskontra owes 999,75. The payment clears
 * what that sale left there, as the bank-match doors do (salePlan.receivableSek):
 * otherwise 0,25 stays on 1510 of a paid invoice, or 3740 takes the öre twice.
 */
describe('settleInvoicePayment: the payment clears what the sale booked first leaves on 1510', () => {
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
  const oreInvoice = () => unbookedInvoice({ total: 999.75, remaining_amount: 999.75 } as Partial<Invoice>)

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, fiscal_period_id: 'fp-pay' })
    vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue({ id: 'je-pay' } as never)
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-custom' } as never)
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-pay')
    vi.mocked(bookInvoice).mockImplementation(async (_ctx, invoiceId, options) => {
      if (options?.dryRun) {
        return { ok: true, dryRun: true, preview: { invoice_id: invoiceId, journal_entry: ORE_SALE_ENTRY } }
      }
      return { ok: true, data: { invoice: { id: invoiceId } as Invoice, journal_entry_id: 'je-sale' }, warnings: [] }
    })
  })

  it('the generated payment clears the 1 000 the sale debited, not the 999,75 the reskontra owes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan)
    enqueue({ data: { ok: true, sek: 1000 } }) // what 1510 carries once the sale is booked
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: oreInvoice(),
      paymentAmountInInvoiceCurrency: 999.75,
    })

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-pay', saleJournalEntryId: 'je-sale' })
    // The ledger is read after the sale is booked, though the row named no verifikat.
    const realBook = vi.mocked(bookInvoice).mock.invocationCallOrder[1]!
    const ledgerRead = vi.mocked(supabase.rpc).mock.invocationCallOrder[0]!
    expect(realBook).toBeLessThan(ledgerRead)
    expect(supabase.rpc).toHaveBeenCalledWith('document_carried_sek', expect.objectContaining({ p_document_id: 'inv-1' }))
    expect(vi.mocked(createInvoicePaymentJournalEntry).mock.calls[0]![3]).toMatchObject({ carried_sek: 1000 })
  })

  it('plans lines against the ledger when a concurrent Bokför booked the sale since the row was read', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_ALREADY_BOOKED' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan: not required any more)
    enqueue({ data: { ok: true, sek: 1000 } }) // what 1510 carries: the concurrent sale
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: oreInvoice(),
      paymentAmountInInvoiceCurrency: 1000,
      customLines: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
      ],
    })

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0, saleJournalEntryId: null })
    expect(realBookCalls()).toHaveLength(0)
  })

  it('accepts lines that clear the 1 000 with no 3740 of their own', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan)
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: oreInvoice(),
      paymentAmountInInvoiceCurrency: 1000,
      customLines: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
      ],
    })

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0, saleJournalEntryId: 'je-sale' })
    expect(realBookCalls()).toHaveLength(1)
  })

  it('refuses lines that book the öre on 3740 again, before the sale is written', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: DEFERRING, error: null }) // company_settings (the plan)

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: oreInvoice(),
      paymentAmountInInvoiceCurrency: 1000,
      customLines: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 999.75 },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
      ],
    })

    expect(result).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(realBookCalls()).toHaveLength(0)
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
  })
})
