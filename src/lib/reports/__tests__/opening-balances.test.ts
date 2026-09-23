import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn(),
}))

import { getOpeningBalances } from '../opening-balances'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const mockFetchAllRows = vi.mocked(fetchAllRows)

function createSupabaseWithRpc(
  rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
) {
  const rpc = vi.fn(rpcImpl)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getOpeningBalances', () => {
  it('returns empty map and null obEntryId when period is null', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = {} as any
    const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', null)

    expect(balances.size).toBe(0)
    expect(obEntryId).toBeNull()
  })

  describe('with opening_balance_entry_id (OB entry path)', () => {
    const period = {
      period_start: '2025-01-01',
      opening_balance_entry_id: 'ob-entry-123',
    }

    it('returns balances from the OB entry lines', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = {} as any
      mockFetchAllRows.mockResolvedValue([
        { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 10000 },
      ])

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period)

      expect(balances.get('1930')).toEqual({ debit: 50000, credit: 0 })
      expect(balances.get('2440')).toEqual({ debit: 0, credit: 10000 })
      expect(obEntryId).toBe('ob-entry-123')
    })

    it('aggregates multiple lines for the same account', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = {} as any
      mockFetchAllRows.mockResolvedValue([
        { account_number: '1930', debit_amount: 30000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 20000, credit_amount: 0 },
      ])

      const { balances } = await getOpeningBalances(supabase, 'company-1', period)

      expect(balances.get('1930')).toEqual({ debit: 50000, credit: 0 })
    })

    it('returns the obEntryId string', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = {} as any
      mockFetchAllRows.mockResolvedValue([])

      const { obEntryId } = await getOpeningBalances(supabase, 'company-1', period)

      expect(obEntryId).toBe('ob-entry-123')
    })
  })

  describe('without opening_balance_entry_id (fallback path via RPC)', () => {
    const period = {
      period_start: '2025-01-01',
      opening_balance_entry_id: null,
    }

    it('calls compute_prior_opening_balances RPC with the right args', async () => {
      const supabase = createSupabaseWithRpc(async () => ({ data: [], error: null }))

      await getOpeningBalances(supabase, 'company-1', period)

      expect(supabase.rpc).toHaveBeenCalledTimes(1)
      expect(supabase.rpc).toHaveBeenCalledWith('compute_prior_opening_balances', {
        p_company_id: 'company-1',
        p_period_start: '2025-01-01',
      })
    })

    it('does NOT call the RPC when an OB entry is present', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = { rpc: vi.fn() } as any
      mockFetchAllRows.mockResolvedValue([])

      await getOpeningBalances(supabase, 'company-1', {
        period_start: '2025-01-01',
        opening_balance_entry_id: 'ob-entry-999',
      })

      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('maps RPC rows to the balances map', async () => {
      const supabase = createSupabaseWithRpc(async () => ({
        data: [
          { account_number: '1930', debit: 100000, credit: 5000 },
          { account_number: '2440', debit: 0, credit: 25000 },
          { account_number: '1510', debit: 8000, credit: 1000 },
        ],
        error: null,
      }))

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period)

      expect(balances.get('1930')).toEqual({ debit: 100000, credit: 5000 })
      expect(balances.get('2440')).toEqual({ debit: 0, credit: 25000 })
      expect(balances.get('1510')).toEqual({ debit: 8000, credit: 1000 })
      expect(obEntryId).toBeNull()
    })

    it('returns empty map when RPC returns no rows', async () => {
      const supabase = createSupabaseWithRpc(async () => ({ data: [], error: null }))

      const { balances } = await getOpeningBalances(supabase, 'company-1', period)

      expect(balances.size).toBe(0)
    })

    it('handles RPC returning null data', async () => {
      const supabase = createSupabaseWithRpc(async () => ({ data: null, error: null }))

      const { balances } = await getOpeningBalances(supabase, 'company-1', period)

      expect(balances.size).toBe(0)
    })

    it('coerces string-typed numerics (Postgres numeric) to numbers', async () => {
      const supabase = createSupabaseWithRpc(async () => ({
        data: [{ account_number: '1930', debit: '12345.67', credit: '0' }],
        error: null,
      }))

      const { balances } = await getOpeningBalances(supabase, 'company-1', period)

      expect(balances.get('1930')).toEqual({ debit: 12345.67, credit: 0 })
    })

    it('throws when the RPC returns an error', async () => {
      const supabase = createSupabaseWithRpc(async () => ({
        data: null,
        error: { message: 'boom' },
      }))

      await expect(getOpeningBalances(supabase, 'company-1', period)).rejects.toThrow('boom')
    })
  })

  it('coerces null/undefined debit/credit to 0 on the OB entry path', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = {} as any
    const period = {
      period_start: '2025-01-01',
      opening_balance_entry_id: 'ob-entry-1',
    }

    mockFetchAllRows.mockResolvedValue([
      { account_number: '1930', debit_amount: null, credit_amount: undefined },
    ])

    const { balances } = await getOpeningBalances(supabase, 'company-1', period)

    expect(balances.get('1930')).toEqual({ debit: 0, credit: 0 })
  })
})
