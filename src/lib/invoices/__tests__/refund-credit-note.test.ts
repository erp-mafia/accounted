import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockPostJournalEntry = vi.fn()
vi.mock('@/lib/posting/port', () => ({
  postingPort: { postJournalEntry: (...args: unknown[]) => mockPostJournalEntry(...args) },
}))

const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

const mockCheckPeriodLock = vi.fn()
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: (...args: unknown[]) => mockCheckPeriodLock(...args),
}))

const mockRecordRow = vi.fn()
const mockRemoveRow = vi.fn()
vi.mock('@/lib/invoices/invoice-payment-row', () => ({
  recordInvoicePaymentRow: (...args: unknown[]) => mockRecordRow(...args),
  removeInvoicePaymentRow: (...args: unknown[]) => mockRemoveRow(...args),
}))

const mockCancelOrphan = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: (...args: unknown[]) => mockCancelOrphan(...args),
}))

import { buildCreditNoteRefundLines, describeRefundFailure, refundCreditNote, type RefundCreditNoteRow } from '../refund-credit-note'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const CREDIT_NOTE: RefundCreditNoteRow = {
  id: 'cn-1',
  invoice_number: 'KR-7',
  customer_id: 'cust-1',
  credited_invoice_id: 'inv-7',
  status: 'sent',
  invoice_date: '2026-10-11',
  total: -10500,
  paid_amount: null,
  currency: 'SEK',
  exchange_rate: null,
  vat_amount: -2100,
  vat_amount_sek: null,
  vat_treatment: 'standard_25',
  journal_entry_id: 'je-credit',
  deduction_total: 0,
  default_dimensions: {},
  customer: { name: 'Kund AB' },
}

function enqueueReads(original: { total: number; paid_amount: number | null } = { total: 10500, paid_amount: 10500 }) {
  enqueue({ data: { id: 'inv-7', ...original } }) // the original
  enqueue({ data: [] }) // credit used by set-offs
}

describe('refundCreditNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockCheckPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockPostJournalEntry.mockResolvedValue({ id: 'je-refund' })
    mockRecordRow.mockResolvedValue({ ok: true, id: 'row-1' })
    mockRemoveRow.mockResolvedValue(true)
  })

  it('refuses a refund dated ahead of today before it reads anything, the dry run included', async () => {
    for (const dryRun of [false, true]) {
      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote: CREDIT_NOTE,
        refundDate: '2099-01-01',
        settlementAccountNumber: '1930',
        dryRun,
      })
      expect(result).toMatchObject({
        ok: false,
        code: 'PAYMENT_DATE_IN_FUTURE',
        details: { field: 'payment_date', attempted: '2099-01-01' },
      })
    }
    expect(findCalls('invoices', 'select')).toEqual([])
    expect(mockPostJournalEntry).not.toHaveBeenCalled()
  })

  it('books Dr 1510 / Cr the bank for what the customer has tillgodo and records it on the credit note', async () => {
    enqueueReads()
    enqueue({ data: [] }) // already-booked guard: nothing
    enqueue({ data: [{ id: 'cn-1' }] }) // compare-and-set

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })

    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      amount: 10500,
      owedAfter: 0,
      journalEntryId: 'je-refund',
      paidAmount: -10500,
      refundedAt: '2026-10-26T12:00:00Z',
    })
    const { input } = mockPostJournalEntry.mock.calls[0][0] as { input: Record<string, unknown> }
    expect(input).toMatchObject({
      fiscal_period_id: 'fp-1',
      entry_date: '2026-10-26',
      source_type: 'invoice_paid',
      source_id: 'cn-1',
      description: 'Återbetalning kreditfaktura KR-7, Kund AB',
    })
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '1510', debit_amount: 10500, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1930', debit_amount: 0, credit_amount: 10500 }),
    ])
    // The sub-ledger row carries the refund as a negative amount on the credit note.
    expect(mockRecordRow).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        invoice: expect.objectContaining({ id: 'cn-1', paid_amount: 0 }),
        newPaidAmount: -10500,
        journalEntryId: 'je-refund',
        paymentDate: '2026-10-26',
        source: 'manual',
      }),
    )
    expect(findCalls('invoices', 'update')[0][0]).toEqual({ paid_amount: -10500, paid_at: '2026-10-26T12:00:00Z' })
    // Its status never moves: credit notes stay out of the payment states.
    expect(findCalls('invoices', 'in')[0]).toEqual(['status', ['sent', 'overdue']])
  })

  it('refunds only what was paid on a part-paid original', async () => {
    enqueueReads({ total: 10500, paid_amount: 4000 })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'cn-1' }] })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: true, amount: 4000, paidAmount: -4000 })
  })

  describe('a credit of 999,75 whose verifikat booked an öresavrundning (Cr 1510 1 000, Dr 3740 0,25)', () => {
    const ROUNDED: RefundCreditNoteRow = { ...CREDIT_NOTE, total: -999.75, vat_amount: -199.95 }
    /** invoice_issue_receivable_sek's row for the credit note: what its verifikat put on 151x, beside its own facts. */
    const voucher = (receivableCredit: number) => ({
      data: [{ invoice_id: 'cn-1', sek: -receivableCredit, currency: 'SEK', total: -999.75, deduction_total: 0 }],
    })

    it('pays back all 1510 carries for it and records the 999,75 it settles', async () => {
      enqueueReads({ total: 999.75, paid_amount: 999.75 })
      enqueue(voucher(1000)) // the credit note's own verifikat
      enqueue({ data: [] }) // already-booked guard: nothing
      enqueue({ data: [{ id: 'cn-1' }] }) // compare-and-set

      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote: ROUNDED,
        refundDate: '2026-10-26',
        settlementAccountNumber: '1930',
      })

      // 1 000 leaves the bank, 1510 nets to zero, and the credit note's own
      // total less paid_amount is zero too, so the kundreskontra agrees.
      expect(result).toMatchObject({ ok: true, amount: 1000, owedAfter: 0, paidAmount: -999.75, refundedAt: '2026-10-26T12:00:00Z' })
      const { input } = mockPostJournalEntry.mock.calls[0][0] as { input: { lines: unknown[] } }
      expect(input.lines).toEqual([
        expect.objectContaining({ account_number: '1510', debit_amount: 1000, credit_amount: 0 }),
        expect.objectContaining({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
      ])
      expect(mockRecordRow).toHaveBeenCalledWith(supabase, expect.objectContaining({ newPaidAmount: -999.75 }))
      expect(findCalls('invoices', 'update')[0][0]).toEqual({ paid_amount: -999.75, paid_at: '2026-10-26T12:00:00Z' })
    })

    it('a part refund takes its own kronor and leaves the öre on 1510 for the last one', async () => {
      enqueueReads({ total: 999.75, paid_amount: 700 })
      enqueue(voucher(1000))
      enqueue({ data: [] })
      enqueue({ data: [{ id: 'cn-1' }] })

      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote: ROUNDED,
        refundDate: '2026-10-26',
        settlementAccountNumber: '1930',
      })
      expect(result).toMatchObject({ ok: true, amount: 700, paidAmount: -700 })
    })

    it('a credit note whose verifikat booked no öre is paid back as before', async () => {
      enqueueReads({ total: 999.75, paid_amount: 999.75 })
      enqueue(voucher(999.75))
      enqueue({ data: [] })
      enqueue({ data: [{ id: 'cn-1' }] })

      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote: ROUNDED,
        refundDate: '2026-10-26',
        settlementAccountNumber: '1930',
      })
      expect(result).toMatchObject({ ok: true, amount: 999.75, owedAfter: 0, paidAmount: -999.75 })
    })

    it('refuses on a failed read of the verifikat rather than leave the öre on 1510', async () => {
      enqueueReads({ total: 999.75, paid_amount: 999.75 })
      enqueue({ data: null, error: { message: 'timeout' } })

      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote: ROUNDED,
        refundDate: '2026-10-26',
        settlementAccountNumber: '1930',
      })
      expect(result).toMatchObject({ ok: false, code: 'DB_ERROR' })
      expect(mockPostJournalEntry).not.toHaveBeenCalled()
    })
  })

  it('refuses when nothing is owed and writes nothing', async () => {
    enqueueReads({ total: 10500, paid_amount: 0 })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: false, code: 'CREDIT_NOTE_REFUND_NOTHING_OWED' })
    expect(mockPostJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses when a hand-booked verifikat already debits 1510 with the amount, unless forced', async () => {
    enqueueReads()
    // Entry first: the company's hand-booked verifikat, then their 1510 debits of the amount.
    enqueue({
      data: [{ id: 'je-manual', entry_date: '2026-10-20', source_type: 'bank_transaction', voucher_series: 'A', voucher_number: 1077 }],
    })
    enqueue({ data: [{ id: 'line-1', journal_entry_id: 'je-manual' }] })
    enqueue({ data: [] }) // no payment row claims it

    const refused = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(refused).toEqual({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_LIKELY_BOOKED',
      details: {
        amount: 10500,
        candidates: [{ journal_entry_id: 'je-manual', entry_date: '2026-10-20', voucher: 'A1077', source_type: 'bank_transaction' }],
      },
    })
    expect(mockPostJournalEntry).not.toHaveBeenCalled()
    // The guard looks a week before the credit note, from the entry side:
    // never lines filtered through a journal_entries!inner embed.
    expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-10-04'])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('journal_entries', 'in')).toContainEqual(['source_type', ['manual', 'bank_transaction']])
    expect(findCalls('journal_entry_lines', 'in')).toContainEqual(['journal_entry_id', ['je-manual']])
    expect(findCalls('journal_entry_lines', 'eq')).toContainEqual(['account_number', '1510'])
    for (const [select] of findCalls('journal_entry_lines', 'select')) {
      expect(String(select)).not.toContain('journal_entries')
    }

    reset()
    enqueueReads()
    enqueue({ data: [{ id: 'cn-1' }] })
    const forced = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
      force: true,
    })
    expect(forced).toMatchObject({ ok: true, journalEntryId: 'je-refund' })
  })

  it('ignores a matching verifikat that a payment row already claims', async () => {
    enqueueReads()
    enqueue({ data: [{ id: 'je-paid', entry_date: '2026-10-20', source_type: 'manual', voucher_series: 'A', voucher_number: 3 }] })
    enqueue({ data: [{ id: 'line-1', journal_entry_id: 'je-paid' }] })
    enqueue({ data: [{ journal_entry_id: 'je-paid' }] })
    enqueue({ data: [{ id: 'cn-1' }] })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: true })
  })

  it('refuses a locked refund date before anything is written', async () => {
    enqueueReads()
    enqueue({ data: [] })
    mockCheckPeriodLock.mockResolvedValue({ locked: true, reason: 'period_locked_at_set' })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-01-15',
      settlementAccountNumber: '1930',
    })
    expect(result).toEqual({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { payment_date: '2026-01-15', reason: 'period_locked_at_set' },
    })
    expect(mockPostJournalEntry).not.toHaveBeenCalled()
  })

  it('plans without writing on a dry run', async () => {
    enqueueReads()
    enqueue({ data: [] })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1931',
      dryRun: true,
    })
    expect(result).toMatchObject({ ok: true, dryRun: true, amount: 10500, journalEntryId: null })
    expect(mockPostJournalEntry).not.toHaveBeenCalled()
    expect(mockRecordRow).not.toHaveBeenCalled()
  })

  it('cancels the voucher and removes the row when another refund won the race', async () => {
    enqueueReads()
    enqueue({ data: [] })
    enqueue({ data: [] }) // compare-and-set matched nothing

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toEqual({ ok: false, code: 'CREDIT_NOTE_REFUND_RACE' })
    expect(mockCancelOrphan).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'je-refund', expect.any(String))
    expect(mockRemoveRow).toHaveBeenCalledWith(supabase, 'company-1', 'row-1')
  })

  it('cancels the voucher when the payment row cannot be saved', async () => {
    enqueueReads()
    enqueue({ data: [] })
    mockRecordRow.mockResolvedValue({ ok: false, error: 'boom' })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_BOOK_FAILED', details: { reason: 'payment_row_insert_failed' } })
    expect(mockCancelOrphan).toHaveBeenCalled()
  })
})

describe('buildCreditNoteRefundLines', () => {
  const note = { invoice_number: 'KR-7', customer: null, default_dimensions: {} }

  it('takes the person\'s own rows for a part refund', () => {
    const built = buildCreditNoteRefundLines(note, 10500, '1930', [
      { account_number: '1510', debit_amount: 500, credit_amount: 0 },
      { account_number: '1686', debit_amount: 0, credit_amount: 500 },
    ])
    expect(built).toMatchObject({ ok: true, amount: 500 })
  })

  it('refuses rows that debit anything but 1510', () => {
    expect(
      buildCreditNoteRefundLines(note, 10500, '1930', [
        { account_number: '3001', debit_amount: 500, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 500 },
      ]),
    ).toEqual({ ok: false, code: 'CREDIT_NOTE_REFUND_LINES_INVALID', details: { reason: 'debit_not_receivable' } })
  })

  it('refuses rows that credit a receivable', () => {
    expect(
      buildCreditNoteRefundLines(note, 10500, '1930', [
        { account_number: '1510', debit_amount: 500, credit_amount: 0 },
        { account_number: '1513', debit_amount: 0, credit_amount: 500 },
      ]),
    ).toMatchObject({ code: 'CREDIT_NOTE_REFUND_LINES_INVALID', details: { reason: 'credit_on_receivable' } })
  })

  it('refuses more than is owed and unbalanced rows', () => {
    expect(
      buildCreditNoteRefundLines(note, 100, '1930', [
        { account_number: '1510', debit_amount: 200, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 200 },
      ]),
    ).toEqual({ ok: false, code: 'CREDIT_NOTE_REFUND_EXCEEDS_OWED', details: { owed: 100, amount: 200 } })
    expect(
      buildCreditNoteRefundLines(note, 100, '1930', [
        { account_number: '1510', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 90 },
      ]),
    ).toMatchObject({ code: 'INVOICE_PAID_LINES_UNBALANCED' })
    // Raw sums that balance, stored amounts that do not.
    expect(
      buildCreditNoteRefundLines(note, 300, '1930', [
        { account_number: '1510', debit_amount: 100.004, credit_amount: 0 },
        { account_number: '1510', debit_amount: 100.004, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 200.01 },
      ]),
    ).toMatchObject({ code: 'INVOICE_PAID_LINES_UNBALANCED' })
  })

  it('carries the credit note\'s dimensions onto the generated pair', () => {
    const built = buildCreditNoteRefundLines({ ...note, default_dimensions: { '6': 'P1' } }, 100, '1930')
    expect(built.ok && built.lines.every((line) => line.dimensions?.['6'] === 'P1')).toBe(true)
  })
})

describe('describeRefundFailure', () => {
  it('names the vouchers that already look like the refund', () => {
    const described = describeRefundFailure({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_LIKELY_BOOKED',
      details: { amount: 100, candidates: [{ journal_entry_id: 'je', entry_date: '2026-10-20', voucher: 'A1077', source_type: 'manual' }] },
    })
    expect(described.code).toBe('CREDIT_NOTE_REFUND_LIKELY_BOOKED')
    expect(described.status).toBe(409)
    expect(described.message).toContain('A1077')
  })
})
