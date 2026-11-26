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

describe('refundCreditNote when the credit note\'s verifikat booked the öresavrundning', () => {
  // A credit of 999,75 whose verifikat mirrors an original issued at the
  // rounded "Att betala": Cr 1510 1 000 / Dr 3740 0,25. The customer paid
  // 1 000 for the original, and 1510 carries -1 000 for the credit.
  const ORE_CREDIT: RefundCreditNoteRow = { ...CREDIT_NOTE, total: -999.75, vat_amount: -199.95 }
  const ORE_LINES = [
    { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    { account_number: '3001', debit_amount: 799.8, credit_amount: 0 },
    { account_number: '2611', debit_amount: 199.95, credit_amount: 0 },
    { account_number: '3740', debit_amount: 0.25, credit_amount: 0 },
  ]

  function enqueueOreReads(
    original: { total: number; paid_amount: number | null } = { total: 999.75, paid_amount: 999.75 },
    liveEntryId: string | null = 'je-credit',
  ) {
    enqueueReads(original)
    enqueue({ data: { entry_id: liveEntryId, exhausted: false } }) // live_journal_entry
    if (liveEntryId) enqueue({ data: { id: liveEntryId, status: 'posted', lines: ORE_LINES } }) // its lines
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockCheckPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockPostJournalEntry.mockResolvedValue({ id: 'je-refund' })
    mockRecordRow.mockResolvedValue({ ok: true, id: 'row-1' })
    mockRemoveRow.mockResolvedValue(true)
  })

  it('pays back what 1510 carries and records the credit note settled at its total', async () => {
    enqueueOreReads()
    enqueue({ data: [] }) // already-booked guard: nothing
    enqueue({ data: [{ id: 'cn-1' }] }) // compare-and-set

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })

    expect(result).toMatchObject({ ok: true, amount: 1000, owedAfter: 0, paidAmount: -999.75, refundedAt: '2026-10-26T12:00:00Z' })
    const { input, event } = mockPostJournalEntry.mock.calls[0][0] as {
      input: { lines: unknown[] }
      event: () => { facts?: Record<string, unknown> }
    }
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '1510', debit_amount: 1000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ])
    expect(mockRecordRow).toHaveBeenCalledWith(supabase, expect.objectContaining({ newPaidAmount: -999.75 }))
    expect(findCalls('invoices', 'update')[0][0]).toEqual({ paid_amount: -999.75, paid_at: '2026-10-26T12:00:00Z' })
    expect(JSON.stringify(event())).toContain('999.75')
    // The verifikat is read as the ledger holds it, inside the company.
    expect(supabase.rpc).toHaveBeenCalledWith('live_journal_entry', { p_company_id: 'company-1', p_entry_id: 'je-credit' })
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('reads the correction a storno left, not the reversed verifikat', async () => {
    enqueueOreReads(undefined, 'je-correction')
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'cn-1' }] })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: true, amount: 1000 })
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['id', 'je-correction'])
  })

  it('pays back the credit note\'s own figure when its verifikat is not live', async () => {
    enqueueOreReads(undefined, null)
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'cn-1' }] })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: true, amount: 999.75, paidAmount: -999.75 })
  })

  it('leaves the öre to the last of two part refunds', async () => {
    enqueueOreReads()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'cn-1' }] })
    const first = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
      customLines: [
        { account_number: '1510', debit_amount: 400, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 400 },
      ],
    })
    expect(first).toMatchObject({ ok: true, amount: 400, owedAfter: 599.75, paidAmount: -400, refundedAt: null })

    reset()
    enqueueOreReads()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'cn-1' }] })
    const last = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: { ...ORE_CREDIT, paid_amount: -400 },
      refundDate: '2026-10-27',
      settlementAccountNumber: '1930',
    })
    // 400 + 600 = the 1 000 1510 carries; 400 + 599,75 = the credit's 999,75.
    expect(last).toMatchObject({ ok: true, amount: 600, owedAfter: 0, paidAmount: -999.75 })
  })

  it('takes the person\'s own rows for what 1510 carries, and no more', async () => {
    enqueueOreReads()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'cn-1' }] })
    const taken = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
      customLines: [
        { account_number: '1510', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ],
    })
    expect(taken).toMatchObject({ ok: true, amount: 1000, owedAfter: 0, paidAmount: -999.75 })

    reset()
    enqueueOreReads()
    const refused = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
      customLines: [
        { account_number: '1510', debit_amount: 1000.5, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000.5 },
      ],
    })
    expect(refused).toEqual({ ok: false, code: 'CREDIT_NOTE_REFUND_EXCEEDS_OWED', details: { owed: 1000, amount: 1000.5 } })
  })

  it.each([
    ['the kundreskontra\'s figure', 999.75],
    ['an amount between the two', 999.9],
  ])('refuses the person\'s rows at %s: they would close the credit with öre on 1510', async (_label, amount) => {
    enqueueOreReads()
    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
      customLines: [
        { account_number: '1510', debit_amount: amount, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: amount },
      ],
    })
    expect(result).toEqual({ ok: false, code: 'CREDIT_NOTE_REFUND_ORE_LEFT', details: { owed: 1000, amount } })
    expect(mockPostJournalEntry).not.toHaveBeenCalled()
  })

  describe('a credit rounded down: Cr 1510 1 000 / Cr 3740 0,25 on 1 000,25', () => {
    const DOWN_CREDIT: RefundCreditNoteRow = { ...CREDIT_NOTE, total: -1000.25, vat_amount: -200.05 }
    const DOWN_LINES = [
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3001', debit_amount: 800.2, credit_amount: 0 },
      { account_number: '2611', debit_amount: 200.05, credit_amount: 0 },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
    ]
    const enqueueDown = (paid: number | null = null) => {
      enqueueReads({ total: 1000.25, paid_amount: 1000.25 })
      enqueue({ data: { entry_id: 'je-credit', exhausted: false } })
      enqueue({ data: { id: 'je-credit', status: 'posted', lines: DOWN_LINES } })
      return { ...DOWN_CREDIT, paid_amount: paid }
    }

    it('pays back the 1 000 1510 carries and records 1 000,25 settled', async () => {
      const creditNote = enqueueDown()
      enqueue({ data: [] })
      enqueue({ data: [{ id: 'cn-1' }] })
      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote,
        refundDate: '2026-10-26',
        settlementAccountNumber: '1930',
      })
      expect(result).toMatchObject({ ok: true, amount: 1000, owedAfter: 0, paidAmount: -1000.25 })
    })

    it('refuses rows at the kundreskontra\'s 1 000,25: more than 1510 carries', async () => {
      const creditNote = enqueueDown()
      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote,
        refundDate: '2026-10-26',
        settlementAccountNumber: '1930',
        customLines: [
          { account_number: '1510', debit_amount: 1000.25, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 1000.25 },
        ],
      })
      expect(result).toEqual({ ok: false, code: 'CREDIT_NOTE_REFUND_EXCEEDS_OWED', details: { owed: 1000, amount: 1000.25 } })
    })

    it('pays out nothing once earlier refunds took all of what 1510 carries', async () => {
      // An earlier refund of 1 000 recorded as a part refund left 0,25 open on
      // the credit note, but 1510 carries nothing more for it.
      const creditNote = enqueueDown(-1000)
      const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
        creditNote,
        refundDate: '2026-10-26',
        settlementAccountNumber: '1930',
      })
      expect(result).toMatchObject({ ok: false, code: 'CREDIT_NOTE_REFUND_NOTHING_OWED' })
      expect(mockPostJournalEntry).not.toHaveBeenCalled()
    })
  })

  it('reads nothing more for a credit note in whole kronor', async () => {
    enqueueReads()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'cn-1' }] })
    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: CREDIT_NOTE,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: true, amount: 10500 })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses with nothing written when the verifikat cannot be read', async () => {
    enqueueReads({ total: 999.75, paid_amount: 999.75 })
    enqueue({ error: { message: 'timeout', code: '57014' } })

    const result = await refundCreditNote(supabase as never, 'company-1', 'user-1', {
      creditNote: ORE_CREDIT,
      refundDate: '2026-10-26',
      settlementAccountNumber: '1930',
    })
    expect(result).toMatchObject({ ok: false, code: 'DB_ERROR' })
    expect(mockPostJournalEntry).not.toHaveBeenCalled()
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
