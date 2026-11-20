import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveDefaultCashAccount } from '../service'

describe('resolveDefaultCashAccount', () => {
  it('asks for bank accounts only, so a company card never takes an unassigned row', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'ca-1940', ledger_account: '1940', is_primary: false, bank_connection_id: null }] })

    const picked = await resolveDefaultCashAccount(supabase as never, 'company-1', 'sek')

    expect(picked).toEqual({ id: 'ca-1940', ledger_account: '1940' })
    const eqArgs = findCalls('cash_accounts', 'eq')
    expect(eqArgs).toContainEqual(['kind', 'bank'])
    expect(eqArgs).toContainEqual(['enabled', true])
    expect(eqArgs).toContainEqual(['currency', 'SEK'])
  })

  it('answers null when the read fails, so the row stays unassigned', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await resolveDefaultCashAccount(supabase as never, 'company-1', 'SEK')).toBeNull()
  })
})
