/**
 * The ledger adapter passes the producer's arguments to the engine as they
 * are: no event and no options, the same arity as the producer's own call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
  createDraftEntry: vi.fn(async () => ({ id: 'je-3' })),
  commitEntry: vi.fn(async () => ({ id: 'je-3' })),
  reverseEntry: vi.fn(async () => ({ id: 'je-2' })),
}))

const { commitEntry, createDraftEntry, createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { ledgerAdapter } = await import('../ledger-adapter')

const INPUT = { description: 'x', lines: [] } as unknown as CreateJournalEntryInput
const LINK = { id: 'ev-1', role: 'produced' as const, onFailure: 'log' as const }

describe('ledger adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls createJournalEntry with exactly the producer\'s six arguments when there is nothing to add', async () => {
    await ledgerAdapter.createJournalEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, rubricVersion: 'r1' })
    const call = vi.mocked(createJournalEntry).mock.calls[0]!
    expect(call).toHaveLength(6)
    expect(call).toEqual(['sb', 'c', 'u', INPUT, undefined, 'r1'])
    expect(call[3]).toBe(INPUT)
  })

  it('adds the link as the engine option, beside the producer\'s own options', async () => {
    await ledgerAdapter.createJournalEntry({
      supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, commitMethod: 'user_accept',
      options: { replayDimensions: true }, businessEvent: LINK,
    })
    expect(vi.mocked(createJournalEntry).mock.calls[0]).toEqual([
      'sb', 'c', 'u', INPUT, 'user_accept', undefined, { replayDimensions: true, businessEvent: LINK },
    ])
    await ledgerAdapter.createJournalEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, options: { replayDimensions: true } })
    expect(vi.mocked(createJournalEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', INPUT, undefined, undefined, { replayDimensions: true }])
  })

  it('drafts with exactly the producer\'s four arguments when there is nothing to add, the link as the fifth', async () => {
    await ledgerAdapter.createDraftEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT })
    const call = vi.mocked(createDraftEntry).mock.calls[0]!
    expect(call).toHaveLength(4)
    expect(call).toEqual(['sb', 'c', 'u', INPUT])
    expect(call[3]).toBe(INPUT)
    await ledgerAdapter.createDraftEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, businessEvent: LINK })
    expect(vi.mocked(createDraftEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', INPUT, { businessEvent: LINK }])
  })

  it('commits with only the arguments the producer passed', async () => {
    await ledgerAdapter.commitEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-3' })
    expect(vi.mocked(commitEntry).mock.calls[0]).toEqual(['sb', 'c', 'u', 'je-3'])
    expect(vi.mocked(commitEntry).mock.calls[0]).toHaveLength(4)
    await ledgerAdapter.commitEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-3', commitMethod: 'user_accept' })
    expect(vi.mocked(commitEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', 'je-3', 'user_accept'])
    await ledgerAdapter.commitEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-3', rubricVersion: 'r1' })
    expect(vi.mocked(commitEntry).mock.calls[2]).toEqual(['sb', 'c', 'u', 'je-3', undefined, 'r1'])
  })

  it('reverses with the same rule', async () => {
    await ledgerAdapter.reverseEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1' })
    expect(vi.mocked(reverseEntry).mock.calls.at(-1)).toEqual(['sb', 'c', 'u', 'je-1'])
    expect(vi.mocked(reverseEntry).mock.calls.at(-1)).toHaveLength(4)
    vi.mocked(reverseEntry).mockClear()
    await ledgerAdapter.reverseEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', reversalDate: '2026-03-31' })
    expect(vi.mocked(reverseEntry).mock.calls[0]).toEqual(['sb', 'c', 'u', 'je-1', '2026-03-31'])
    await ledgerAdapter.reverseEntry({
      supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', options: { allowDeepChain: true }, businessEvent: LINK,
    })
    expect(vi.mocked(reverseEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', 'je-1', undefined, { allowDeepChain: true, businessEvent: LINK }])
  })
})
