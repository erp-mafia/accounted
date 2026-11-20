import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { readKnownCards } from '../known-cards'

const COMPANY = 'company-1'

describe('readKnownCards', () => {
  it('a registered company card is known without a bank read', async () => {
    const { supabase, tables, findCalls } = createTableMockSupabase({
      cash_accounts: { data: [{ card_last4: ['6776', '1111'] }] },
    })
    expect([...(await readKnownCards(supabase as never, COMPANY, ['6776']))]).toEqual(['6776'])
    expect(tables()).not.toContain('transactions')
    expect(findCalls('cash_accounts', 'eq')).toEqual([['company_id', COMPANY], ['kind', 'card']])
  })

  it('a card the company\'s own bank rows print as a card token is known', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      cash_accounts: { data: [] },
      transactions: { data: [{ merchant_name: null, description: 'UBER TRIP K6776', original_description: null }] },
    })
    expect([...(await readKnownCards(supabase as never, COMPANY, ['6776']))]).toEqual(['6776'])
    expect(findCalls('transactions', 'eq')).toEqual([['company_id', COMPANY]])
  })

  it('the same digits as an amount or an order number are no card; a misread number is unknown (crm#1534)', async () => {
    const { supabase } = createTableMockSupabase({
      cash_accounts: { data: [{ card_last4: ['6776'] }] },
      transactions: { data: [{ merchant_name: null, description: 'ORDER 5905 BETALNING 2026-10-27', original_description: null }] },
    })
    expect((await readKnownCards(supabase as never, COMPANY, ['5905'])).size).toBe(0)
  })

  it('reads nothing for no card number', async () => {
    const { supabase, tables } = createTableMockSupabase({})
    expect((await readKnownCards(supabase as never, COMPANY, [null, '', '12345'])).size).toBe(0)
    expect(tables()).toEqual([])
  })

  it('throws on a failed read, for the caller to treat the card as unknown', async () => {
    const { supabase } = createTableMockSupabase({ cash_accounts: { data: null, error: { message: 'boom' } } })
    await expect(readKnownCards(supabase as never, COMPANY, ['6776'])).rejects.toThrow('card account read failed')
  })
})
