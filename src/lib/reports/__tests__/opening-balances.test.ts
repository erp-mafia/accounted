import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/dimension-carry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/dimension-carry')>()),
  fetchAccumulatingDimensions: vi.fn(),
}))

import { getOpeningBalances } from '../opening-balances'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchAccumulatingDimensions } from '@/lib/bookkeeping/dimension-carry'

const mockFetchAllRows = vi.mocked(fetchAllRows)
const mockAccumulating = vi.mocked(fetchAccumulatingDimensions)

function createSupabaseWithRpc(
  rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
) {
  const rpc = vi.fn(rpcImpl)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  // No journal rows unless a test queues them: on the fallback path the first
  // entry read is the lookup of an unlinked IB verifikat.
  mockFetchAllRows.mockReset()
  mockFetchAllRows.mockResolvedValue([])
  // The seeded registry: projekt (6) accumulates, everything else resets.
  mockAccumulating.mockResolvedValue(new Set(['6']))
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

  describe('dimension-scoped IB (issue #3313)', () => {
    /** Chainable query recorder: every builder call lands in `calls`. */
    function recordingSupabase(calls: Array<[string, unknown[]]>) {
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get: (_t, prop) => (...args: unknown[]) => {
            calls.push([String(prop), args])
            return chain
          },
        }
      )
      return { from: (table: string) => { calls.push(['from', [table]]); return chain } }
    }

    it('filters the IB entry\'s lines by jsonb containment', async () => {
      const calls: Array<[string, unknown[]]> = []
      const supabase = recordingSupabase(calls)
      // First fetchAllRows: the IB entry; second: its lines. Run each query
      // builder so the filters it applies are recorded.
      mockFetchAllRows
        .mockImplementationOnce(async (build) => {
          build({ from: 0, to: 999 })
          return [{ id: 'ob-entry-123' }]
        })
        .mockImplementationOnce(async (build) => {
          build({ from: 0, to: 999 })
          return [{ id: 'l1', account_number: '1470', debit_amount: 1200, credit_amount: 0 }]
        })

      const { balances, obEntryId } = await getOpeningBalances(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase as any,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: 'ob-entry-123' },
        { dimensions: { '6': 'P1' } }
      )

      expect(calls).toContainEqual(['contains', ['dimensions', { '6': 'P1' }]])
      expect(balances.get('1470')).toEqual({ debit: 1200, credit: 0 })
      expect(obEntryId).toBe('ob-entry-123')
    })

    it('does not filter the IB entry\'s lines without a filter', async () => {
      const calls: Array<[string, unknown[]]> = []
      const supabase = recordingSupabase(calls)
      mockFetchAllRows
        .mockImplementationOnce(async (build) => {
          build({ from: 0, to: 999 })
          return [{ id: 'ob-entry-123' }]
        })
        .mockImplementationOnce(async (build) => {
          build({ from: 0, to: 999 })
          return []
        })
      await getOpeningBalances(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase as any,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: 'ob-entry-123' },
        { dimensions: {} }
      )
      expect(calls.some(([method]) => method === 'contains')).toBe(false)
    })

    it('passes p_dimensions to the fallback RPC only under a filter', async () => {
      const supabase = createSupabaseWithRpc(async () => ({
        data: [{ account_number: '1470', debit: 1300, credit: 0 }],
        error: null,
      }))
      const period = { period_start: '2026-01-01', opening_balance_entry_id: null }

      const { balances } = await getOpeningBalances(supabase, 'company-1', period, { dimensions: { '6': 'P1' } })
      expect(supabase.rpc).toHaveBeenLastCalledWith('compute_prior_opening_balances', {
        p_company_id: 'company-1',
        p_period_start: '2026-01-01',
        p_dimensions: { '6': 'P1' },
      })
      expect(balances.get('1470')).toEqual({ debit: 1300, credit: 0 })

      await getOpeningBalances(supabase, 'company-1', period)
      expect(supabase.rpc).toHaveBeenLastCalledWith('compute_prior_opening_balances', {
        p_company_id: 'company-1',
        p_period_start: '2026-01-01',
      })
      // The registry is read only under a filter.
      expect(mockAccumulating).toHaveBeenCalledTimes(1)
    })

    it('opens a dimension that resets annually at 0 on the fallback path, whatever the history carries', async () => {
      // Prior history holds kostnadsställe-tagged 1470 lines; the RPC would
      // sum them. Kostnadsställe resets annually, so it is never asked.
      const supabase = createSupabaseWithRpc(async () => ({
        data: [{ account_number: '1470', debit: 300, credit: 0 }],
        error: null,
      }))
      const { balances, obEntryId } = await getOpeningBalances(
        supabase,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: null },
        { dimensions: { '1': 'K1' } }
      )
      expect(balances.size).toBe(0)
      expect(obEntryId).toBeNull()
      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(mockAccumulating).toHaveBeenCalledWith(supabase, 'company-1')
    })

    it('opens a dimension that resets annually at 0 on the IB entry path too, and keeps obEntryId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = {} as any
      const { balances, obEntryId } = await getOpeningBalances(
        supabase,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: 'ob-entry-123' },
        { dimensions: { '1': 'K1' } }
      )
      expect(balances.size).toBe(0)
      // Callers still exclude the IB entry from the period lines.
      expect(obEntryId).toBe('ob-entry-123')
      expect(mockFetchAllRows).not.toHaveBeenCalled()
    })

    it('opens at 0 when any filter key resets annually (a project within a kostnadsställe)', async () => {
      const supabase = createSupabaseWithRpc(async () => ({ data: [], error: null }))
      const { balances } = await getOpeningBalances(
        supabase,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: null },
        { dimensions: { '6': 'P1', '1': 'K1' } }
      )
      expect(balances.size).toBe(0)
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('opens the VAT accounts (26xx) at 0 under a filter on both paths, the rest scoped as usual', async () => {
      // Fallback: the history holds a project invoice's tagged output VAT
      // (settled untagged), which the RPC sums per project. Not a project IB.
      const supabase = createSupabaseWithRpc(async () => ({
        data: [
          { account_number: '1510', debit: 1250, credit: 0 },
          { account_number: '2611', debit: 0, credit: 250 },
        ],
        error: null,
      }))
      const fallback = await getOpeningBalances(
        supabase,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: null },
        { dimensions: { '6': 'P1' } }
      )
      expect([...fallback.balances.keys()]).toEqual(['1510'])

      // IB entry path: a hand-tagged 26xx IB line is left out the same way.
      mockFetchAllRows.mockResolvedValueOnce([{ id: 'ob-entry-123' }]).mockResolvedValueOnce([
        { id: 'l1', account_number: '1510', debit_amount: 1250, credit_amount: 0 },
        { id: 'l2', account_number: '2611', debit_amount: 0, credit_amount: 250 },
      ])
      const linked = await getOpeningBalances(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { from: vi.fn() } as any,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: 'ob-entry-123' },
        { dimensions: { '6': 'P1' } }
      )
      expect([...linked.balances.keys()]).toEqual(['1510'])

      // Unfiltered, 26xx is an ordinary IB account.
      const unfiltered = await getOpeningBalances(supabase, 'company-1', {
        period_start: '2026-01-01',
        opening_balance_entry_id: null,
      })
      expect(unfiltered.balances.get('2611')).toEqual({ debit: 0, credit: 250 })
    })

    it('follows the company registry, not the SIE default', async () => {
      // A company whose custom dimension 20 accumulates carries its IB.
      mockAccumulating.mockResolvedValue(new Set(['6', '20']))
      const supabase = createSupabaseWithRpc(async () => ({
        data: [{ account_number: '1470', debit: 400, credit: 0 }],
        error: null,
      }))
      const { balances } = await getOpeningBalances(
        supabase,
        'company-1',
        { period_start: '2026-01-01', opening_balance_entry_id: null },
        { dimensions: { '20': 'X' } }
      )
      expect(balances.get('1470')).toEqual({ debit: 400, credit: 0 })
    })

    it('fails the read rather than guess when the registry cannot be read', async () => {
      mockAccumulating.mockRejectedValue(new Error('Failed to read the dimension registry: boom'))
      const supabase = createSupabaseWithRpc(async () => ({ data: [], error: null }))
      await expect(
        getOpeningBalances(
          supabase,
          'company-1',
          { period_start: '2026-01-01', opening_balance_entry_id: null },
          { dimensions: { '6': 'P1' } }
        )
      ).rejects.toThrow(/dimension registry/)
      expect(supabase.rpc).not.toHaveBeenCalled()
    })
  })

  describe('a posted IB verifikat the period does not point at (crm#1845)', () => {
    const period = { period_start: '2026-05-01', opening_balance_entry_id: null }
    const unlinked = {
      entryId: 'ib-unlinked',
      lines: [
        { account_number: '1930', debit_amount: 400, credit_amount: 0, dimensions: null },
        { account_number: '1630', debit_amount: 30, credit_amount: 0, dimensions: null },
        { account_number: '2081', debit_amount: 0, credit_amount: 430, dimensions: null },
      ],
    }

    it('opens an account with earlier history on the history alone, and the rest on the verifikat', async () => {
      // 1930 and 2081 were carried in from the earlier years; the IB verifikat
      // restates them. 1630 has no history: its IB line is its opening balance.
      const supabase = createSupabaseWithRpc(async () => ({
        data: [
          { account_number: '1930', debit: 400, credit: 0 },
          { account_number: '2081', debit: 0, credit: 400 },
        ],
        error: null,
      }))

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period, { unlinked })

      expect(balances.get('1930')).toEqual({ debit: 400, credit: 0 })
      expect(balances.get('2081')).toEqual({ debit: 0, credit: 400 })
      expect(balances.get('1630')).toEqual({ debit: 30, credit: 0 })
      // The caller leaves the verifikat out of the period movement.
      expect(obEntryId).toBe('ib-unlinked')
      expect(mockFetchAllRows).not.toHaveBeenCalled()
    })

    it('opens on the verifikat when the company has no earlier history', async () => {
      const supabase = createSupabaseWithRpc(async () => ({ data: [], error: null }))

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period, { unlinked })

      expect(balances.get('1930')).toEqual({ debit: 400, credit: 0 })
      expect(balances.get('1630')).toEqual({ debit: 30, credit: 0 })
      expect(balances.get('2081')).toEqual({ debit: 0, credit: 430 })
      expect(obEntryId).toBe('ib-unlinked')
    })

    it('looks the verifikat up itself when the caller has not', async () => {
      const supabase = createSupabaseWithRpc(async () => ({
        data: [{ account_number: '1930', debit: 400, credit: 0 }],
        error: null,
      }))
      mockFetchAllRows
        .mockResolvedValueOnce([{ id: 'ib-unlinked' }])
        .mockResolvedValueOnce([
          { id: 'l1', journal_entry_id: 'ib-unlinked', account_number: '1930', debit_amount: 400, credit_amount: 0, dimensions: null },
          { id: 'l2', journal_entry_id: 'ib-unlinked', account_number: '2081', debit_amount: 0, credit_amount: 400, dimensions: null },
        ])

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period)

      expect(obEntryId).toBe('ib-unlinked')
      expect(balances.get('1930')).toEqual({ debit: 400, credit: 0 })
      expect(balances.get('2081')).toEqual({ debit: 0, credit: 400 })
    })

    it('is handed null: no lookup, the derived balances as before', async () => {
      const supabase = createSupabaseWithRpc(async () => ({
        data: [{ account_number: '1930', debit: 400, credit: 0 }],
        error: null,
      }))

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period, { unlinked: null })

      expect(obEntryId).toBeNull()
      expect([...balances.keys()]).toEqual(['1930'])
      expect(mockFetchAllRows).not.toHaveBeenCalled()
    })

    it('never looks for one when the period points at its IB, whatever the history holds', async () => {
      const supabase = createSupabaseWithRpc(async () => ({
        data: [{ account_number: '1930', debit: 999, credit: 0 }],
        error: null,
      }))
      // The linked entry's read: the entry, then its lines.
      mockFetchAllRows
        .mockResolvedValueOnce([{ id: 'ib-linked' }])
        .mockResolvedValueOnce([{ id: 'l1', account_number: '1930', debit_amount: 400, credit_amount: 0 }])

      const { balances, obEntryId } = await getOpeningBalances(
        supabase,
        'company-1',
        { period_start: '2026-05-01', opening_balance_entry_id: 'ib-linked' },
        // A stale lookup result is ignored too: the pointer decides.
        { unlinked },
      )

      expect(obEntryId).toBe('ib-linked')
      expect(balances.get('1930')).toEqual({ debit: 400, credit: 0 })
      expect(balances.size).toBe(1)
      // Nothing but the linked entry's read: no lookup, no derived balances.
      expect(mockFetchAllRows).toHaveBeenCalledTimes(2)
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('under a project filter decides history on all lines, and opens on the tagged IB lines only', async () => {
      // 1470 has earlier history, though none of it on P1; 1510 has none.
      const supabase = createSupabaseWithRpc(async (_fn, args) => ({
        data: args.p_dimensions ? [] : [{ account_number: '1470', debit: 100, credit: 0 }],
        error: null,
      }))

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period, {
        dimensions: { '6': 'P1' },
        unlinked: {
          entryId: 'ib-unlinked',
          lines: [
            { account_number: '1470', debit_amount: 100, credit_amount: 0, dimensions: { '6': 'P1' } },
            { account_number: '1510', debit_amount: 50, credit_amount: 0, dimensions: { '6': 'P1' } },
            { account_number: '1510', debit_amount: 70, credit_amount: 0, dimensions: { '6': 'P2' } },
            { account_number: '2611', debit_amount: 0, credit_amount: 20, dimensions: { '6': 'P1' } },
          ],
        },
      })

      expect(obEntryId).toBe('ib-unlinked')
      expect(balances.has('1470')).toBe(false)
      expect(balances.get('1510')).toEqual({ debit: 50, credit: 0 })
      // VAT accounts are never split per object.
      expect(balances.has('2611')).toBe(false)
    })

    it('keeps the verifikat out of the period under a filter on a dimension that resets annually', async () => {
      const supabase = createSupabaseWithRpc(async () => ({ data: [], error: null }))

      const { balances, obEntryId } = await getOpeningBalances(supabase, 'company-1', period, {
        dimensions: { '1': 'K1' },
        unlinked,
      })

      expect(balances.size).toBe(0)
      expect(obEntryId).toBe('ib-unlinked')
      expect(supabase.rpc).not.toHaveBeenCalled()
    })
  })
})
