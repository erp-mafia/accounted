import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  OUTGOING_PICKER_LIMIT,
  searchUnmatchedOutgoingTransactions,
} from '../outgoing-transaction-search'

/**
 * The bank-row picker on the new supplier invoice form used to load the newest
 * 200 unmatched outgoing rows and filter them in the browser, so an older
 * payment could never be found. The search term now goes to the database.
 */
describe('searchUnmatchedOutgoingTransactions', () => {
  it('without a term reads the newest unmatched outgoing rows, capped', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await searchUnmatchedOutgoingTransactions(supabase as never, 'company-1', '  ')

    expect(findCall('open_bank_rows', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('open_bank_rows', 'lt')).toEqual(['amount', 0])
    expect(findCalls('open_bank_rows', 'is')).toEqual([
      ['supplier_invoice_id', null],
      ['invoice_id', null],
    ])
    expect(findCall('open_bank_rows', 'ilike')).toBeUndefined()
    expect(findCall('open_bank_rows', 'limit')).toEqual([OUTGOING_PICKER_LIMIT])
  })

  it('sends a term to the database as an escaped description search', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await searchUnmatchedOutgoingTransactions(supabase as never, 'company-1', ' 50%_rabatt ')

    expect(findCall('open_bank_rows', 'ilike')).toEqual(['description', '%50\\%\\_rabatt%'])
  })

  it('says when the answer came back full', async () => {
    const full = Array.from({ length: OUTGOING_PICKER_LIMIT }, (_, i) => ({
      id: `tx-${i}`,
      date: '2026-10-01',
      description: 'Betalning',
      amount: -100,
      currency: 'SEK',
    }))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: full })

    const result = await searchUnmatchedOutgoingTransactions(supabase as never, 'company-1', '')

    expect(result.rows).toHaveLength(OUTGOING_PICKER_LIMIT)
    expect(result.capped).toBe(true)
  })

  it('throws on a failed read, for the picker to show its empty state', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })

    await expect(searchUnmatchedOutgoingTransactions(supabase as never, 'company-1', 'x')).rejects.toThrow('boom')
  })
})
