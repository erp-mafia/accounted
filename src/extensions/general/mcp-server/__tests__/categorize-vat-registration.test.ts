/**
 * gnubok_categorize_transaction: the staged preview is built by the same
 * category-mapping seam the commit executor books through, and the core
 * loads company_settings.vat_registered next to the entity type. A company
 * that is not VAT-registered therefore previews (and later books) no moms
 * line (lib/bookkeeping/vat-registration.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockDetectDup = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

// The booking service's chart pre-validation and period-lock pre-check have
// their own tests; complete and open here.
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))

import { tools } from '../server'

const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!

const TX_ID = '00000000-0000-4000-8000-0000000000ee'

const coreTxRow = () => ({
  id: TX_ID,
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
  is_business: true,
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectDup.mockResolvedValue(null)
})

describe('gnubok_categorize_transaction: VAT registration', () => {
  it.each([
    { vat_registered: false, vatLines: [] },
    {
      vat_registered: true,
      vatLines: [expect.objectContaining({ account_number: '2641', debit_amount: 250 })],
    },
  ])(
    'previews a company with vat_registered = $vat_registered through the mapping seam',
    async ({ vat_registered, vatLines }) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: coreTxRow() }) // core: transactions
      enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
      enqueue({ data: { entity_type: 'ideell_forening', fiscal_year_start_month: 1, vat_registered } })
      enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
      enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
      enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
      enqueue({ data: [], error: null }) // open operations on these rows: none (crm#1264)
      enqueue({ data: { id: 'op-vat-1' } }) // pending_operations insert

      const result = (await categorize.execute(
        { transaction_id: TX_ID, category: 'expense_software' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      )) as { staged: boolean; preview: { debit_account: string; vat_lines: unknown[] } }

      expect(result.staged).toBe(true)
      expect(result.preview.debit_account).toBe('5420')
      expect(result.preview.vat_lines).toEqual(vatLines)
    },
  )
})
