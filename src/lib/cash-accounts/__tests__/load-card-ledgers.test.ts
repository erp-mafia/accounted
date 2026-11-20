import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadCardLedgers, needsCardLedgers } from '../load-card-ledgers'

describe('needsCardLedgers', () => {
  it('asks only when the bank leg is card-shaped and not the row\'s own ledger', () => {
    expect(needsCardLedgers({ debit_account: '6540', credit_account: '2890' }, -349, '1930')).toBe(true)
    expect(needsCardLedgers({ debit_account: '2890', credit_account: '6540' }, 349, '1930')).toBe(true)
    expect(needsCardLedgers({ debit_account: '6540', credit_account: '2890' }, -349, '2890')).toBe(false)
    expect(needsCardLedgers({ debit_account: '6540', credit_account: '1930' }, -349, '1930')).toBe(false)
    // The counter leg is never the bank leg.
    expect(needsCardLedgers({ debit_account: '2890', credit_account: '1930' }, -12345, '1930')).toBe(false)
  })
})

describe('loadCardLedgers', () => {
  it('reads the company\'s card rows', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ ledger_account: '2890' }, { ledger_account: '2899' }] })
    expect(await loadCardLedgers(supabase as never, 'company-1')).toEqual(['2890', '2899'])
    expect(findCalls('cash_accounts', 'eq')).toEqual([['company_id', 'company-1'], ['kind', 'card']])
  })

  it('answers [] when the read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await loadCardLedgers(supabase as never, 'company-1')).toEqual([])
  })
})
