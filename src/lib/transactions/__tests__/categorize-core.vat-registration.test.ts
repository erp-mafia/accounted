/**
 * categorizeMatchedTransaction (the MCP staged-commit and inbox bulk-book
 * path) reaches the same category-mapping seam as the routes: it loads
 * company_settings.vat_registered with the entity type and hands it to the
 * builder as loaded, so a non-registered company books no moms line
 * (lib/bookkeeping/vat-registration.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import { categorizeMatchedTransaction } from '../categorize-core'

const TX_ID = '00000000-0000-4000-8000-0000000000dd'

const txRow = () => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-07-10',
  amount: -1250,
  currency: 'SEK',
  amount_sek: -1250,
  exchange_rate: 1,
  description: 'ADOBE',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreateJE.mockResolvedValue({ id: 'je-vat-1' })
})

describe('categorizeMatchedTransaction: VAT registration', () => {
  it.each([
    { vat_registered: false, vatLines: [] },
    {
      vat_registered: true,
      vatLines: [expect.objectContaining({ account_number: '2641', debit_amount: 250 })],
    },
  ])(
    'books a company with vat_registered = $vat_registered through the mapping seam',
    async ({ vat_registered, vatLines }) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: txRow() }) // transactions select
      enqueue({ data: { entity_type: 'ideell_forening', fiscal_year_start_month: 1, vat_registered } })
      enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
      enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod: open period exists
      enqueue({ data: [{ id: TX_ID }] }) // transactions update

      const result = await categorizeMatchedTransaction(
        supabase as never, 'user-1', 'company-1', TX_ID, { category: 'expense_software' },
      )

      expect(result.error).toBeUndefined()
      expect(result.data?.journal_entry_id).toBe('je-vat-1')
      const mapping = mockCreateJE.mock.calls[0][4] as { debit_account: string; vat_lines: unknown[] }
      expect(mapping.debit_account).toBe('5420')
      expect(mapping.vat_lines).toEqual(vatLines)
    },
  )
})
