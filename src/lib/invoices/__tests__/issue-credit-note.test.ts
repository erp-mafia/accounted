import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { CreditNote } from '@/types'

const mockCreateCreditNoteJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createCreditNoteJournalEntry: (...args: unknown[]) =>
    mockCreateCreditNoteJournalEntry(...args),
}))

const mockCancelSchedulesForSource = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: (...args: unknown[]) =>
    mockCancelSchedulesForSource(...args),
}))

const mockCheckPeriodLock = vi.fn()
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: (...args: unknown[]) => mockCheckPeriodLock(...args),
}))

const mockBookInvoice = vi.fn()
vi.mock('@/lib/invoices/book-service', () => ({
  bookInvoice: (...args: unknown[]) => mockBookInvoice(...args),
}))

const mockGetDeductionShareBooked = vi.fn()
vi.mock('@/lib/invoices/rot-rut-payout-recognition', () => ({
  getDeductionShareBookedByPayout: (...args: unknown[]) => mockGetDeductionShareBooked(...args),
}))

import {
  creditIssueFailureCode,
  creditNoteNeedsJournalEntry,
  issueCreditNote,
} from '@/lib/invoices/issue-credit-note'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}

function makeCreditNote(overrides: Partial<CreditNote> = {}) {
  return {
    ...makeInvoice({
      id: 'credit-1',
      invoice_number: 'KR-F-100',
      invoice_date: '2026-07-14',
      status: 'draft',
      credited_invoice_id: 'invoice-1',
      subtotal: -1000,
      vat_amount: -250,
      total: -1250,
      ...overrides,
    }),
    customer: { name: 'Testkund' },
  } as CreditNote & { customer: { name: string } }
}

describe('issueCreditNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockCancelSchedulesForSource.mockResolvedValue({
      cancelledSchedules: 1,
      reversedEntries: 0,
      failedReversals: 0,
    })
  })

  it('books an accrual credit note, links it, cancels accruals, and marks the original', async () => {
    enqueue({ data: null, error: null })
    enqueue({ data: { voucher_series: 'A', voucher_number: 42 }, error: null })
    mockCreateCreditNoteJournalEntry.mockResolvedValue({ id: 'journal-1' })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const result = await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: {
        id: 'invoice-1',
        invoice_number: 'F-100',
        status: 'sent',
        journal_entry_id: 'original-journal-1',
      },
      entityType: 'enskild_firma',
      accountingMethod: 'accrual',
      deferInvoiceBooking: false,
      log,
    })

    expect(result).toEqual({
      complete: true,
      journalEntryId: 'journal-1',
      journalEntryRequired: true,
      repairRequired: false,
      failures: [],
    })
    expect(mockCreateCreditNoteJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'credit-1', status: 'sent' }),
      'enskild_firma',
      'Testkund',
      'A-42',
      expect.any(Function), // what the door saw, read by the posting port only while POSTING_EVENTS is on
      { deductionBookedSek: null },
    )
    expect(mockCancelSchedulesForSource).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      { invoiceId: 'invoice-1' },
      { reversalDate: '2026-07-14' },
    )
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'credit_note.created' }),
    )
  })

  it('marks and emits a cash-method credit note without creating a journal entry', async () => {
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: { id: 'invoice-1', invoice_number: 'F-100', status: 'sent' },
      entityType: 'enskild_firma',
      accountingMethod: 'cash',
      deferInvoiceBooking: false,
      log,
    })

    expect(result).toEqual({
      complete: true,
      journalEntryId: null,
      journalEntryRequired: false,
      repairRequired: false,
      failures: [],
    })
    expect(mockCreateCreditNoteJournalEntry).not.toHaveBeenCalled()
    expect(mockCancelSchedulesForSource).not.toHaveBeenCalled()
  })

  // crm#1886: the original kept the amount it asked for before the credit, so
  // a reader of remaining_amount alone was told the customer still owed it.
  it('leaves nothing to pay on the credited original, in the write that moves it to credited', async () => {
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: { id: 'invoice-1', invoice_number: 'F-100', status: 'sent' },
      entityType: 'enskild_firma',
      accountingMethod: 'cash',
      deferInvoiceBooking: false,
      log,
    })

    // One write on the original, compare-and-set on the statuses a credit may leave.
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'credited', remaining_amount: 0 }]])
    expect(findCalls('invoices', 'in')).toEqual([['status', ['sent', 'paid', 'overdue']]])
  })

  it('does not touch the original, its remaining amount included, when the credit could not be booked', async () => {
    enqueue({ data: null, error: null })
    mockCreateCreditNoteJournalEntry.mockRejectedValue(new Error('Perioden är låst'))

    const result = await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: { id: 'invoice-1', invoice_number: 'F-100', status: 'sent' },
      entityType: 'enskild_firma',
      accountingMethod: 'accrual',
      deferInvoiceBooking: false,
      log,
    })

    expect(result.complete).toBe(false)
    expect(findCalls('invoices', 'update')).toEqual([])
  })

  it('does not cancel accrual schedules when the credit journal entry fails', async () => {
    enqueue({ data: null, error: null })
    mockCreateCreditNoteJournalEntry.mockRejectedValue(new Error('Perioden är låst'))

    const result = await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: { id: 'invoice-1', invoice_number: 'F-100', status: 'sent' },
      entityType: 'enskild_firma',
      accountingMethod: 'accrual',
      deferInvoiceBooking: false,
      log,
    })

    expect(result.journalEntryId).toBeNull()
    expect(result.complete).toBe(false)
    expect(result.failures).toEqual([
      { step: 'journal_entry', reason: 'Perioden är låst' },
    ])
    expect(mockCancelSchedulesForSource).not.toHaveBeenCalled()
  })

  it('books a paid cash-method original before marking it credited', async () => {
    enqueue({ data: null, error: null })
    mockCreateCreditNoteJournalEntry.mockResolvedValue({ id: 'journal-cash' })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: {
        id: 'invoice-1',
        invoice_number: 'F-100',
        status: 'paid',
        paid_at: '2026-07-01T00:00:00Z',
      },
      entityType: 'enskild_firma',
      accountingMethod: 'cash',
      deferInvoiceBooking: false,
      log,
    })

    expect(result.complete).toBe(true)
    expect(result.journalEntryId).toBe('journal-cash')
    expect(mockCreateCreditNoteJournalEntry).toHaveBeenCalledOnce()
    expect(mockCancelSchedulesForSource).not.toHaveBeenCalled()
  })

  it('detects when cash-method credit notes need a reversal voucher', () => {
    const original = { id: 'invoice-1', invoice_number: 'F-100', status: 'sent' }
    expect(creditNoteNeedsJournalEntry('cash', original)).toBe(false)
    expect(creditNoteNeedsJournalEntry('cash', { ...original, status: 'paid' })).toBe(true)
    expect(creditNoteNeedsJournalEntry('cash', { ...original, paid_amount: 100 })).toBe(true)
    expect(creditNoteNeedsJournalEntry('accrual', original)).toBe(true)
  })

  it('reuses the posted voucher that wins a concurrent create race', async () => {
    enqueue({ data: null, error: null })
    mockCreateCreditNoteJournalEntry.mockRejectedValue(new Error('duplicate source'))
    enqueue({ data: { id: 'journal-winner' }, error: null })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: { id: 'invoice-1', invoice_number: 'F-100', status: 'sent' },
      entityType: 'enskild_firma',
      accountingMethod: 'accrual',
      deferInvoiceBooking: false,
      log,
    })

    expect(result.complete).toBe(true)
    expect(result.journalEntryId).toBe('journal-winner')
    expect(result.failures).toEqual([])
  })
})

// accounted#45: under faktureringsmetoden with defer_invoice_booking a sent
// invoice can still lack its verifikat. Its credit must not reverse a sale
// the books never recorded: the original is booked first (the Bokför step),
// then the credit posts.
describe('issueCreditNote: a deferred original that was never booked', () => {
  const unbookedOriginal = {
    id: 'invoice-1',
    invoice_number: 'F-100',
    status: 'sent',
    journal_entry_id: null,
    paid_at: null,
    paid_amount: 0,
  }

  function issueDeferred(overrides: Partial<Parameters<typeof issueCreditNote>[0]> = {}) {
    return issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: makeCreditNote(),
      originalInvoice: unbookedOriginal,
      entityType: 'aktiebolag',
      accountingMethod: 'accrual',
      deferInvoiceBooking: true,
      log,
      ...overrides,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockCancelSchedulesForSource.mockResolvedValue({ cancelledSchedules: 0, reversedEntries: 0, failedReversals: 0 })
    mockCheckPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
    mockBookInvoice.mockResolvedValue({
      ok: true,
      data: { invoice: { id: 'invoice-1' }, journal_entry_id: 'original-journal-1' },
      warnings: [],
    })
    mockCreateCreditNoteJournalEntry.mockResolvedValue({ id: 'credit-journal-1' })
  })

  it('books the original first through the Bokför step, then the credit that refers to it', async () => {
    enqueue({ data: null, error: null }) // no credit verifikat yet
    enqueue({ data: { voucher_series: 'A', voucher_number: 7 }, error: null }) // the new original verifikat
    enqueue({ data: [{ id: 'credit-1' }], error: null }) // credit link
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // original flipped to credited

    const result = await issueDeferred()

    expect(result).toEqual({
      complete: true,
      journalEntryId: 'credit-journal-1',
      journalEntryRequired: true,
      repairRequired: false,
      failures: [],
      originalJournalEntryId: 'original-journal-1',
    })
    expect(mockBookInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      'invoice-1',
    )
    // The credit is checked on its own date before the original is booked.
    expect(mockCheckPeriodLock).toHaveBeenCalledWith(expect.anything(), 'company-1', '2026-07-14')
    // Order: the original's verifikat, then the credit's, which names it.
    expect(mockBookInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateCreditNoteJournalEntry.mock.invocationCallOrder[0],
    )
    expect(mockCreateCreditNoteJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'credit-1', status: 'sent' }),
      'aktiebolag',
      'Testkund',
      'A-7',
      expect.any(Function), // what the door saw, read by the posting port only while POSTING_EVENTS is on
      { deductionBookedSek: null },
    )
  })

  it('refuses the credit when the original is in a locked period: nothing posts, the original stays as it was', async () => {
    enqueue({ data: null, error: null })
    mockBookInvoice.mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_is_closed', fiscal_period_id: 'fp-old', invoice_date: '2026-03-16' },
    })

    const result = await issueDeferred()

    expect(result.complete).toBe(false)
    expect(result.journalEntryId).toBeNull()
    expect(result.repairRequired).toBe(false)
    expect(result).not.toHaveProperty('originalJournalEntryId')
    expect(result.failures).toEqual([
      expect.objectContaining({
        step: 'original_booking',
        code: 'INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED',
        details: expect.objectContaining({ original_invoice_id: 'invoice-1', reason: 'period_is_closed', invoice_date: '2026-03-16' }),
      }),
    ])
    expect(mockCreateCreditNoteJournalEntry).not.toHaveBeenCalled()
    expect(mockCancelSchedulesForSource).not.toHaveBeenCalled()
    expect(creditIssueFailureCode(result)).toEqual({
      code: 'INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED',
      details: expect.objectContaining({ failure_steps: ['original_booking'] }),
    })
  })

  it('refuses with the Bokför step\'s own code when the original cannot be booked for another reason', async () => {
    enqueue({ data: null, error: null })
    mockBookInvoice.mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_NO_FISCAL_PERIOD', details: { invoiceDate: '2026-07-01' } })

    const result = await issueDeferred()

    expect(result.failures).toEqual([
      expect.objectContaining({
        step: 'original_booking',
        code: 'INVOICE_CREDIT_ORIGINAL_BOOK_FAILED',
        details: expect.objectContaining({ original_booking_code: 'INVOICE_BOOK_NO_FISCAL_PERIOD' }),
      }),
    ])
    expect(mockCreateCreditNoteJournalEntry).not.toHaveBeenCalled()
  })

  it('does not book the original when the credit\'s own date cannot take its verifikat', async () => {
    enqueue({ data: null, error: null })
    mockCheckPeriodLock.mockResolvedValue({ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-1' })

    const result = await issueDeferred()

    expect(result.complete).toBe(false)
    expect(result.failures).toEqual([expect.objectContaining({ step: 'journal_entry' })])
    expect(mockBookInvoice).not.toHaveBeenCalled()
    expect(mockCreateCreditNoteJournalEntry).not.toHaveBeenCalled()
    expect(creditIssueFailureCode(result).code).toBe('INVOICE_CREDIT_ISSUE_INCOMPLETE')
  })

  it('keeps the booked original and says so when the credit itself then fails', async () => {
    enqueue({ data: null, error: null })
    enqueue({ data: { voucher_series: 'A', voucher_number: 7 }, error: null })
    mockCreateCreditNoteJournalEntry.mockRejectedValue(new Error('Perioden är låst'))
    enqueue({ data: null, error: null }) // recovery lookup finds no credit verifikat

    const result = await issueDeferred()

    expect(result.complete).toBe(false)
    expect(result.journalEntryId).toBeNull()
    expect(result.originalJournalEntryId).toBe('original-journal-1')
    expect(result.failures).toEqual([
      { step: 'journal_entry', reason: 'Perioden är låst Originalfakturan har bokförts. Försök kreditera igen.' },
    ])
  })

  it('reverses the verifikat a concurrent Bokför posted instead of failing', async () => {
    enqueue({ data: null, error: null })
    mockBookInvoice.mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_ALREADY_BOOKED' })
    enqueue({ data: { journal_entry_id: 'concurrent-journal-1' }, error: null })
    enqueue({ data: { voucher_series: 'A', voucher_number: 9 }, error: null })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueDeferred()

    expect(result.complete).toBe(true)
    expect(result.originalJournalEntryId).toBe('concurrent-journal-1')
    expect(mockCreateCreditNoteJournalEntry.mock.calls[0][6]).toBe('A-9')
  })

  it('repairs an issued credit without booking anything again', async () => {
    enqueue({ data: { id: 'credit-journal-1' }, error: null }) // the credit verifikat exists
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueDeferred()

    expect(result.complete).toBe(true)
    expect(mockBookInvoice).not.toHaveBeenCalled()
    expect(mockCreateCreditNoteJournalEntry).not.toHaveBeenCalled()
  })

  it('leaves a booked original on the plain reversal path', async () => {
    enqueue({ data: null, error: null })
    enqueue({ data: { voucher_series: 'A', voucher_number: 42 }, error: null })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueDeferred({
      originalInvoice: { ...unbookedOriginal, journal_entry_id: 'original-journal-42' },
    })

    expect(result.complete).toBe(true)
    expect(result).not.toHaveProperty('originalJournalEntryId')
    expect(mockBookInvoice).not.toHaveBeenCalled()
    expect(mockCreateCreditNoteJournalEntry.mock.calls[0][6]).toBe('A-42')
  })

  it('books nothing first for a company that books at issue: an unlinked original there is in the ledger already', async () => {
    enqueue({ data: null, error: null })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueDeferred({ deferInvoiceBooking: false })

    expect(result.complete).toBe(true)
    expect(mockBookInvoice).not.toHaveBeenCalled()
    expect(mockCreateCreditNoteJournalEntry).toHaveBeenCalledOnce()
  })

  it('keeps kontantmetoden as it was: an unpaid original is credited without any verifikat', async () => {
    enqueue({ data: [{ id: 'invoice-1' }], error: null })

    const result = await issueDeferred({ accountingMethod: 'cash' })

    expect(result).toEqual({
      complete: true,
      journalEntryId: null,
      journalEntryRequired: false,
      repairRequired: false,
      failures: [],
    })
    expect(mockBookInvoice).not.toHaveBeenCalled()
    expect(mockCreateCreditNoteJournalEntry).not.toHaveBeenCalled()
  })
})

// Kontantmetodens two steps (ML 2023:200 7 kap. 16 §): an original whose
// payment booked only the customer's share is credited for that share and
// what its payout booked of Skatteverket's, nothing more.
describe('issueCreditNote: a kontantmetod ROT/RUT original', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockCancelSchedulesForSource.mockResolvedValue({ cancelledSchedules: 0, reversedEntries: 0, failedReversals: 0 })
  })

  const rotCreditNote = () =>
    makeCreditNote({
      items: [{
        id: 'item-1', invoice_id: 'credit-1', sort_order: 0, description: 'Arbete', quantity: -1, unit: 'st',
        unit_price: 10000, line_total: -10000, vat_rate: 25, vat_amount: -2500,
        deduction_type: 'rot', deduction_amount: 3750, created_at: '2026-07-01T00:00:00Z',
      }],
    } as never)

  async function issue(accountingMethod: 'cash' | 'accrual') {
    enqueue({ data: null, error: null }) // existing credit verifikat lookup
    mockCreateCreditNoteJournalEntry.mockResolvedValue({ id: 'journal-1' })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null })
    return issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: rotCreditNote(),
      originalInvoice: { id: 'invoice-1', invoice_number: 'F-100', status: 'paid', journal_entry_id: null, paid_amount: 8750 },
      entityType: 'enskild_firma',
      accountingMethod,
      deferInvoiceBooking: false,
      log,
    })
  }

  it('credits the customer share alone while Skatteverket\'s share is unbooked', async () => {
    mockGetDeductionShareBooked.mockResolvedValue({ ok: true, bookedSek: 0 })
    const result = await issue('cash')
    expect(result.complete).toBe(true)
    expect(mockGetDeductionShareBooked).toHaveBeenCalledWith(
      supabase,
      'company-1',
      { id: 'invoice-1', journal_entry_id: null },
      '2026-07-14',
    )
    expect(mockCreateCreditNoteJournalEntry.mock.calls[0][8]).toEqual({ deductionBookedSek: 0 })
  })

  it('credits what a partial payout booked of the share (issue #93), and all of it once paid in full', async () => {
    mockGetDeductionShareBooked.mockResolvedValue({ ok: true, bookedSek: 3000 })
    await issue('cash')
    expect(mockCreateCreditNoteJournalEntry.mock.calls[0][8]).toEqual({ deductionBookedSek: 3000 })

    vi.clearAllMocks()
    reset()
    mockGetDeductionShareBooked.mockResolvedValue({ ok: true, bookedSek: null })
    await issue('cash')
    expect(mockCreateCreditNoteJournalEntry.mock.calls[0][8]).toEqual({ deductionBookedSek: null })
  })

  it('refuses before posting when a partial beslut over several invoices names no per-invoice amounts', async () => {
    mockGetDeductionShareBooked.mockResolvedValue({
      ok: false,
      code: 'ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN',
      details: { request_id: 'req-1', reason: 'per_invoice_amounts_unknown' },
    })
    enqueue({ data: null, error: null }) // existing credit verifikat lookup
    const result = await issueCreditNote({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      creditNote: rotCreditNote(),
      originalInvoice: { id: 'invoice-1', invoice_number: 'F-100', status: 'paid', journal_entry_id: null, paid_amount: 8750 },
      entityType: 'enskild_firma',
      accountingMethod: 'cash',
      deferInvoiceBooking: false,
      log,
    })
    expect(result.complete).toBe(false)
    expect(result.journalEntryId).toBeNull()
    expect(result.failures).toEqual([
      expect.objectContaining({ step: 'journal_entry', code: 'ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN' }),
    ])
    expect(mockCreateCreditNoteJournalEntry).not.toHaveBeenCalled()
  })

  it('faktureringsmetoden never asks', async () => {
    await issue('accrual')
    expect(mockGetDeductionShareBooked).not.toHaveBeenCalled()
    expect(mockCreateCreditNoteJournalEntry.mock.calls[0][8]).toEqual({ deductionBookedSek: null })
  })
})
