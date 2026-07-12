import { describe, it, expect, vi } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'
import { resolveSettlementAccount } from '../settlement-account'
import { BookkeepingDatabaseError } from '../errors'

const noopLog = { warn: vi.fn() } as unknown as import('@/lib/logger').Logger

describe('resolveSettlementAccount', () => {
  it('returns 1930 when the transaction has no cash_account_id', async () => {
    const { supabase } = createMockSupabase()

    const result = await resolveSettlementAccount(supabase as never, 'company-1', null, noopLog)

    expect(result).toBe('1930')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns the linked cash account ledger_account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { ledger_account: '1940' }, error: null })

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog)

    expect(result).toBe('1940')
    expect(supabase.from).toHaveBeenCalledWith('cash_accounts')
  })

  it('throws a BookkeepingDatabaseError instead of silently falling back when the lookup errors', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: { message: 'boom' } })

    await expect(
      resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    await expect(
      resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog),
    ).rejects.toMatchObject({
      operation: 'resolve_settlement_account',
      message: expect.stringContaining('boom'),
    })
  })

  it('falls back to 1930 when cash_account_id does not match any row', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: null })

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-unknown', noopLog)

    expect(result).toBe('1930')
  })

  it('falls back to 1930 and warns when the row has no ledger_account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { ledger_account: null }, error: null })
    const warn = vi.fn()

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', {
      warn,
    } as unknown as import('@/lib/logger').Logger)

    expect(result).toBe('1930')
    expect(warn).toHaveBeenCalledWith(
      'settlement-account lookup returned no ledger_account; defaulting to 1930',
      expect.objectContaining({ cashAccountId: 'ca-1' }),
    )
  })
})
