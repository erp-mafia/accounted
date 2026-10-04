/**
 * The engine side of a pro-rata kontantmetoden installment:
 * createInvoiceCashPartialEntry books the lines the builder produced, and
 * checkPriorCashRecognition refuses to book the next installment on top of
 * earlier payments the ledger does not show as pro-rata ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('../engine')
const { checkPriorCashRecognition, createInvoiceCashPartialEntry } = await import('../invoice-entries')

const INSTALLMENT = {
  description: 'Kontant delbetalning kundfaktura 2026-042, Kund AB',
  lines: [
    { account_number: '1689', debit_amount: 500, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 400 },
    { account_number: '2611', debit_amount: 0, credit_amount: 100 },
  ],
}

describe('createInvoiceCashPartialEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findFiscalPeriod).mockResolvedValue('period-1')
    vi.mocked(createJournalEntry).mockImplementation(
      async (_s: unknown, _c: string, _u: string, input: CreateJournalEntryInput) =>
        ({ id: 'entry-1', ...input }) as never,
    )
  })

  it('books the given lines as a cash payment of the invoice on the payment date', async () => {
    const entry = await createInvoiceCashPartialEntry(
      {} as SupabaseClient,
      'company-1',
      'user-1',
      'inv-1',
      INSTALLMENT,
      '2026-09-30',
    )

    expect(entry?.id).toBe('entry-1')
    expect(vi.mocked(findFiscalPeriod)).toHaveBeenCalledWith({}, 'company-1', '2026-09-30')
    expect(vi.mocked(createJournalEntry)).toHaveBeenCalledWith({}, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2026-09-30',
      description: INSTALLMENT.description,
      source_type: 'invoice_cash_payment',
      source_id: 'inv-1',
      lines: INSTALLMENT.lines,
    })
  })

  it('returns null without booking when no open period covers the date', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValue(null)
    const entry = await createInvoiceCashPartialEntry(
      {} as SupabaseClient,
      'company-1',
      'user-1',
      'inv-1',
      INSTALLMENT,
      '2026-09-30',
    )
    expect(entry).toBeNull()
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })
})

describe('checkPriorCashRecognition', () => {
  const EXPECTED = { '3001': 400, '2611': 100 }

  function check(supabase: unknown, priorPaid = 500) {
    return checkPriorCashRecognition(supabase as SupabaseClient, 'company-1', 'inv-1', priorPaid, EXPECTED)
  }

  it('accepts earlier installments booked pro rata, settlement legs ignored', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ amount: 200, journal_entry_id: 'je-1' }, { amount: 300, journal_entry_id: 'je-2' }] })
    enqueue({ data: [{ id: 'je-1', status: 'posted' }, { id: 'je-2', status: 'posted' }] })
    enqueue({
      data: [
        { journal_entry_id: 'je-1', account_number: '1930', debit_amount: 200, credit_amount: 0 },
        { journal_entry_id: 'je-1', account_number: '3001', debit_amount: 0, credit_amount: 160 },
        { journal_entry_id: 'je-1', account_number: '2611', debit_amount: 0, credit_amount: 40 },
        { journal_entry_id: 'je-2', account_number: '1689', debit_amount: 300, credit_amount: 0 },
        { journal_entry_id: 'je-2', account_number: '3001', debit_amount: 0, credit_amount: 240 },
        { journal_entry_id: 'je-2', account_number: '2611', debit_amount: 0, credit_amount: 60 },
      ],
    })

    await expect(check(supabase)).resolves.toEqual({ ok: true })
    // Scoped to the company and the invoice; lines only of those vouchers.
    expect(findCalls('invoice_payments', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['invoice_id', 'inv-1'],
    ])
    expect(findCalls('journal_entries', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('journal_entry_lines', 'in')).toEqual([['journal_entry_id', ['je-1', 'je-2']]])
  })

  it('reads one voucher once when two payment rows share it', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ amount: 250, journal_entry_id: 'je-1' }, { amount: 250, journal_entry_id: 'je-1' }] })
    enqueue({ data: [{ id: 'je-1', status: 'posted' }] })
    enqueue({
      data: [
        { journal_entry_id: 'je-1', account_number: '3001', debit_amount: 0, credit_amount: 400 },
        { journal_entry_id: 'je-1', account_number: '2611', debit_amount: 0, credit_amount: 100 },
      ],
    })

    await expect(check(supabase)).resolves.toEqual({ ok: true })
    expect(findCalls('journal_entries', 'in')).toEqual([['id', ['je-1']]])
  })

  it('refuses a ledger that recognised the whole invoice on the first installment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ amount: 500, journal_entry_id: 'je-1' }] })
    enqueue({ data: [{ id: 'je-1', status: 'posted' }] })
    enqueue({
      data: [
        { journal_entry_id: 'je-1', account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { journal_entry_id: 'je-1', account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { journal_entry_id: 'je-1', account_number: '2611', debit_amount: 0, credit_amount: 250 },
      ],
    })

    await expect(check(supabase)).resolves.toEqual({
      ok: false,
      reason: 'prior_payments_not_pro_rata',
      details: {
        // Account numbers are integer-like keys: they iterate in numeric order.
        accounts: [
          { account: '2611', expected: 100, booked: 250 },
          { account: '3001', expected: 400, booked: 1000 },
        ],
      },
    })
  })

  it('refuses a voucher that booked the revenue on another account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ amount: 500, journal_entry_id: 'je-1' }] })
    enqueue({ data: [{ id: 'je-1', status: 'posted' }] })
    enqueue({
      data: [
        { journal_entry_id: 'je-1', account_number: '3041', debit_amount: 0, credit_amount: 400 },
        { journal_entry_id: 'je-1', account_number: '2611', debit_amount: 0, credit_amount: 100 },
      ],
    })

    const result = await check(supabase)
    expect(result).toMatchObject({ ok: false, reason: 'prior_payments_not_pro_rata' })
  })

  it('refuses payment rows that do not add up to paid_amount (an import without vouchers)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await expect(check(supabase)).resolves.toEqual({
      ok: false,
      reason: 'prior_payments_untraceable',
      details: { payment_rows_total: 0, paid_amount: 500 },
    })
    expect(findCalls('journal_entries', 'select')).toHaveLength(0)
  })

  it('refuses a payment row without a voucher', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ amount: 200, journal_entry_id: 'je-1' }, { amount: 300, journal_entry_id: null }] })
    const result = await check(supabase)
    expect(result).toMatchObject({ ok: false, reason: 'prior_payments_untraceable' })
  })

  it.each([
    ['reversed', [{ id: 'je-1', status: 'reversed' }]],
    ['missing', []],
  ])('refuses a payment row whose voucher is %s', async (_label, entries) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ amount: 500, journal_entry_id: 'je-1' }] })
    enqueue({ data: entries })
    const result = await check(supabase)
    expect(result).toEqual({ ok: false, reason: 'prior_payments_untraceable' })
  })

  it.each([
    ['the payment rows', 0],
    ['the vouchers', 1],
    ['the voucher lines', 2],
  ])('refuses when %s cannot be read: unknown is never a match', async (_label, failingStep) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const steps = [
      { data: [{ amount: 500, journal_entry_id: 'je-1' }] },
      { data: [{ id: 'je-1', status: 'posted' }] },
      { data: [] },
    ]
    steps.forEach((step, i) => enqueue(i === failingStep ? { data: null, error: { message: 'boom' } } : step))
    const result = await check(supabase)
    expect(result).toEqual({ ok: false, reason: 'prior_payments_unreadable' })
  })
})
