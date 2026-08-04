import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { seedSandboxJournalEntries } from '../journal-entries'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
}))

const mockCreateJournalEntry = vi.mocked(createJournalEntry)

describe('seedSandboxJournalEntries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateJournalEntry
      .mockResolvedValueOnce({ id: 'invoice-entry' } as never)
      .mockResolvedValueOnce({ id: 'payment-entry' } as never)
  })

  it('creates both balanced demo vouchers through the bookkeeping engine', async () => {
    const supabase = {} as never

    const result = await seedSandboxJournalEntries({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      fiscalPeriodId: 'period-1',
      invoiceId: 'invoice-1',
      invoiceEntryDate: '2026-07-01',
      paymentEntryDate: '2026-07-15',
    })

    expect(result.invoiceEntry).toMatchObject({ id: 'invoice-entry' })
    expect(result.paymentEntry).toMatchObject({ id: 'payment-entry' })
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(2)
    expect(mockCreateJournalEntry).toHaveBeenNthCalledWith(
      1,
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: 'period-1',
        entry_date: '2026-07-01',
        source_type: 'invoice_created',
        source_id: 'invoice-1',
        lines: [
          expect.objectContaining({ account_number: '1510', debit_amount: 18750 }),
          expect.objectContaining({ account_number: '3001', credit_amount: 15000 }),
          expect.objectContaining({ account_number: '2611', credit_amount: 3750 }),
        ],
      }),
    )
    expect(mockCreateJournalEntry).toHaveBeenNthCalledWith(
      2,
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: 'period-1',
        entry_date: '2026-07-15',
        source_type: 'invoice_paid',
        source_id: 'invoice-1',
        lines: [
          expect.objectContaining({ account_number: '1930', debit_amount: 18750 }),
          expect.objectContaining({ account_number: '1510', credit_amount: 18750 }),
        ],
      }),
    )
  })
})
