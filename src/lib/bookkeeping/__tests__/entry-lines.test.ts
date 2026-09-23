import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  fetchEntryLines,
  fetchLinesByEntryIds,
  type EntryLinesQuery,
} from '../entry-lines'

/**
 * Recording variant of the queued Supabase mock: every `.from()` starts a
 * chain that consumes the next queued result AND records each chained method
 * call (name + args), so tests can assert the query shape the helper builds
 * (chunk sizes for `.in()`, forced columns in `.select()`, paging order).
 */
function createRecordingSupabase() {
  const queue: { data: unknown; error: unknown }[] = []
  const chains: { method: string; args: unknown[] }[][] = []

  const enqueue = (result: { data?: unknown; error?: unknown }) => {
    queue.push({ data: result.data ?? null, error: result.error ?? null })
  }

  const buildChain = (
    result: { data: unknown; error: unknown },
    chainCalls: { method: string; args: unknown[] }[],
  ): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (...args: unknown[]) => {
          chainCalls.push({ method: String(prop), args })
          return buildChain(result, chainCalls)
        }
      },
    }
    return new Proxy({}, handler)
  }

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      const chainCalls: { method: string; args: unknown[] }[] = [
        { method: 'from', args: [table] },
      ]
      chains.push(chainCalls)
      const result = queue.shift() || { data: null, error: null }
      return buildChain(result, chainCalls)
    }),
  }

  const callOf = (chain: { method: string; args: unknown[] }[], method: string) =>
    chain.find((c) => c.method === method)

  return { supabase, enqueue, chains, callOf }
}

function makeEntries(count: number): { id: string; entry_date: string }[] {
  // Zero-padded ids keep lexicographic order == numeric order.
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${String(i).padStart(4, '0')}`,
    entry_date: '2024-06-15',
  }))
}

describe('fetchEntryLines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns [] without querying lines when no entries match', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // journal_entries page

    const lines = await fetchEntryLines({
      supabase: supabase as unknown as SupabaseClient,
      lineColumns: 'id, account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) => q.eq('company_id', 'company-1'),
    })

    expect(lines).toEqual([])
    // Only the entries query ran: no journal_entry_lines round-trip.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('journal_entries')
  })

  it('chunks line fetches at 100 entry ids per .in() query', async () => {
    const { supabase, enqueue, chains, callOf } = createRecordingSupabase()
    const entries = makeEntries(250)
    enqueue({ data: entries }) // journal_entries page
    enqueue({ data: [{ id: 'line-1', journal_entry_id: entries[0].id }] }) // chunk 1
    enqueue({ data: [] }) // chunk 2
    enqueue({ data: [] }) // chunk 3

    const lines = await fetchEntryLines<{ id: string; journal_entry_id: string }>({
      supabase: supabase as unknown as SupabaseClient,
      lineColumns: 'id, account_number',
      filterEntries: (q: EntryLinesQuery) => q.eq('company_id', 'company-1'),
    })

    expect(lines).toHaveLength(1)
    // 1 entries query + 3 line chunks (100 + 100 + 50).
    expect(chains).toHaveLength(4)
    expect(chains[0][0]).toEqual({ method: 'from', args: ['journal_entries'] })
    const chunkSizes = chains.slice(1).map((chain) => {
      expect(chain[0]).toEqual({ method: 'from', args: ['journal_entry_lines'] })
      const inCall = callOf(chain, 'in')
      expect(inCall?.args[0]).toBe('journal_entry_id')
      return (inCall?.args[1] as string[]).length
    })
    expect(chunkSizes).toEqual([100, 100, 50])
  })

  it('reattaches the parent entry under journal_entries by default', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'entry-1', entry_date: '2024-01-15', voucher_number: 1 },
        { id: 'entry-2', entry_date: '2024-02-15', voucher_number: 2 },
      ],
    })
    enqueue({
      data: [
        { id: 'line-1', journal_entry_id: 'entry-1', account_number: '1930' },
        { id: 'line-2', journal_entry_id: 'entry-2', account_number: '3001' },
      ],
    })

    const lines = await fetchEntryLines<{
      id: string
      journal_entry_id: string
      account_number: string
      journal_entries: { id: string; entry_date: string; voucher_number: number }
    }>({
      supabase: supabase as unknown as SupabaseClient,
      entryColumns: 'id, entry_date, voucher_number',
      lineColumns: 'id, account_number',
      filterEntries: (q: EntryLinesQuery) => q.eq('company_id', 'company-1'),
    })

    expect(lines).toHaveLength(2)
    expect(lines[0].journal_entries).toEqual({
      id: 'entry-1',
      entry_date: '2024-01-15',
      voucher_number: 1,
    })
    expect(lines[1].journal_entries.voucher_number).toBe(2)
  })

  it('reattaches under a custom key for aliased embeds', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'entry-1', entry_date: '2024-01-15' }] })
    enqueue({ data: [{ id: 'line-1', journal_entry_id: 'entry-1' }] })

    const lines = await fetchEntryLines<{
      id: string
      journal_entry: { id: string; entry_date: string }
    }>({
      supabase: supabase as unknown as SupabaseClient,
      entryColumns: 'id, entry_date',
      lineColumns: 'id',
      filterEntries: (q: EntryLinesQuery) => q,
      attachEntriesAs: 'journal_entry',
    })

    expect(lines[0].journal_entry).toEqual({ id: 'entry-1', entry_date: '2024-01-15' })
    expect((lines[0] as Record<string, unknown>).journal_entries).toBeUndefined()
  })

  it('skips reattachment when attachEntriesAs is null', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'entry-1' }] })
    enqueue({ data: [{ id: 'line-1', journal_entry_id: 'entry-1' }] })

    const lines = await fetchEntryLines<Record<string, unknown>>({
      supabase: supabase as unknown as SupabaseClient,
      lineColumns: 'id',
      filterEntries: (q: EntryLinesQuery) => q,
      attachEntriesAs: null,
    })

    expect(lines[0].journal_entries).toBeUndefined()
  })

  it('applies filterLines to every chunk query', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeEntries(150) })
    enqueue({ data: [] })
    enqueue({ data: [] })

    const filterLines = vi.fn((q: EntryLinesQuery) => q)
    await fetchEntryLines({
      supabase: supabase as unknown as SupabaseClient,
      lineColumns: 'id',
      filterEntries: (q: EntryLinesQuery) => q,
      filterLines,
    })

    // 150 entries -> 2 chunks -> filterLines once per chunk.
    expect(filterLines).toHaveBeenCalledTimes(2)
  })

  it('forces id and journal_entry_id into the selects', async () => {
    const { supabase, enqueue, chains, callOf } = createRecordingSupabase()
    enqueue({ data: [{ id: 'entry-1', entry_date: '2024-01-15' }] })
    enqueue({ data: [] })

    await fetchEntryLines({
      supabase: supabase as unknown as SupabaseClient,
      // Neither list names the forced columns.
      entryColumns: 'entry_date',
      lineColumns: 'account_number',
      filterEntries: (q: EntryLinesQuery) => q,
    })

    const entrySelect = callOf(chains[0], 'select')?.args[0] as string
    expect(entrySelect.split(',').map((s) => s.trim())).toContain('id')
    const lineSelect = callOf(chains[1], 'select')?.args[0] as string
    const lineCols = lineSelect.split(',').map((s) => s.trim())
    expect(lineCols).toContain('id')
    expect(lineCols).toContain('journal_entry_id')
    // Both queries page on a stable unique order (fetch-all.ts invariant).
    expect(callOf(chains[0], 'order')?.args[0]).toBe('id')
    expect(callOf(chains[1], 'order')?.args[0]).toBe('id')
  })

  it('propagates entry query errors', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })

    await expect(
      fetchEntryLines({
        supabase: supabase as unknown as SupabaseClient,
        lineColumns: 'id',
        filterEntries: (q: EntryLinesQuery) => q,
      }),
    ).rejects.toThrow('boom')
  })
})

describe('fetchLinesByEntryIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns [] for an empty id list without querying', async () => {
    const { supabase } = createQueuedMockSupabase()

    const lines = await fetchLinesByEntryIds(
      supabase as unknown as SupabaseClient,
      [],
      'id, account_number',
    )

    expect(lines).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('sorts lines by id ascending across chunks', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const entryIds = makeEntries(150).map((e) => e.id)
    // Chunk results arrive unsorted relative to each other; ids are
    // zero-padded so lexicographic order is deterministic.
    enqueue({
      data: [
        { id: 'line-0300', journal_entry_id: entryIds[0] },
        { id: 'line-0100', journal_entry_id: entryIds[1] },
      ],
    })
    enqueue({
      data: [
        { id: 'line-0200', journal_entry_id: entryIds[100] },
      ],
    })

    const lines = await fetchLinesByEntryIds<{ id: string }>(
      supabase as unknown as SupabaseClient,
      entryIds,
      'id',
    )

    expect(lines.map((l) => l.id)).toEqual(['line-0100', 'line-0200', 'line-0300'])
  })

  it('propagates line query errors', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'lines boom' } })

    await expect(
      fetchLinesByEntryIds(supabase as unknown as SupabaseClient, ['entry-1'], 'id'),
    ).rejects.toThrow('lines boom')
  })
})
