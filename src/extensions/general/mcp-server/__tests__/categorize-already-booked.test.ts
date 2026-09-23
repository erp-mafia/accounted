/**
 * gnubok_categorize_transaction on a transaction that already has a
 * journal entry.
 *
 * categorizeTransactionCore returns a success-shaped object for this case
 * ({ success: true, journal_entry_created: false, journal_entry_error }),
 * which the tool used to pass through as its result. STAGED_OPERATION_SCHEMA
 * requires staged/risk_level/actor/message/preview, so strict clients
 * rejected the structured content and the agent saw only "Structured content
 * does not match the tool's output schema" with the real reason swallowed
 * (feedback seq 288574). The dispatcher's isError path carries no
 * structuredContent, so an Error is the only schema-conformant way out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))

import { tools } from '../server'

const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!

const TX_ID = '00000000-0000-4000-8000-0000000000aa'
const JE_ID = '00000000-0000-4000-8000-0000000000bb'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_categorize_transaction: already booked', () => {
  it('throws a plain error naming the existing verifikat instead of returning an off-schema object', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: TX_ID,
        date: '2026-08-26',
        amount: 25000,
        currency: 'SEK',
        amount_sek: 25000,
        exchange_rate: null,
        description: 'Aktiekapital',
        merchant_name: null,
        cash_account_id: null,
        document_id: null,
        journal_entry_id: JE_ID,
        is_business: true,
      },
      error: null,
    }) // core: transactions select('*')

    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'income_other' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' } as never,
      ),
    ).rejects.toThrow(new RegExp(`already booked \\(journal_entry_id ${JE_ID}\\)`))
  })
})
