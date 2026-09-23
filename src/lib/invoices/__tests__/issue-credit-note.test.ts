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

import {
  creditNoteNeedsJournalEntry,
  issueCreditNote,
} from '@/lib/invoices/issue-credit-note'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
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
      log,
    })

    expect(result.complete).toBe(true)
    expect(result.journalEntryId).toBe('journal-winner')
    expect(result.failures).toEqual([])
  })
})
