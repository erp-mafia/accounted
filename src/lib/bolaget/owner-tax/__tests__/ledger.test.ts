import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loanAccountBalances } from '../ledger'
import { accountBalanceThrough } from '@/lib/bookkeeping/account-balance'

vi.mock('@/lib/bookkeeping/account-balance', () => ({ accountBalanceThrough: vi.fn() }))

const read = accountBalanceThrough as ReturnType<typeof vi.fn>
const supabase = {} as SupabaseClient

describe('loanAccountBalances', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads each account once, on the day asked, through the balance reader every surface shares', async () => {
    // The reader floors at the ingående balans: 2893 after a year-end stands
    // at -50 000, not the -100 000 every posting adds up to.
    read.mockImplementation(async (_s, _c, account: string) => (account === '2893' ? -50000 : 12000))

    const balances = await loanAccountBalances(supabase, 'company-1', ['2893', '1685', '2893'], '2026-11-12')

    expect([...balances]).toEqual([['2893', -50000], ['1685', 12000]])
    expect(read.mock.calls).toEqual([
      [supabase, 'company-1', '2893', '2026-11-12'],
      [supabase, 'company-1', '1685', '2026-11-12'],
    ])
  })

  it('answers null for an account whose balance cannot be read, and keeps the others', async () => {
    read.mockImplementation(async (_s, _c, account: string) => {
      if (account === '2893') throw new Error('Kunde inte läsa ingående balans: statement timeout')
      return account === '1685' ? null : 0
    })

    const balances = await loanAccountBalances(supabase, 'company-1', ['2893', '1685', '2350'], '2026-11-12')

    expect([...balances]).toEqual([['2893', null], ['1685', null], ['2350', 0]])
  })

  it('reads nothing for no accounts', async () => {
    expect((await loanAccountBalances(supabase, 'company-1', [], '2026-11-12')).size).toBe(0)
    expect(read).not.toHaveBeenCalled()
  })
})
