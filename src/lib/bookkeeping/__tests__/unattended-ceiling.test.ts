/**
 * An API key's unattended ceiling at the engine (#125): every commit door
 * that draws a voucher number asks the actor of the scope first, so a v1
 * door that posts (categorize, batch-categorize, mark-paid, a storno, ...)
 * cannot pass the ceiling just because the door never reads it.
 *
 * The property under test is that NOTHING reaches the database's commit:
 * a refusal before commit_journal_entry draws no number and leaves no gap
 * (BFL 5 kap. 7 §). And a commit without a ceiling reads nothing extra.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@/lib/bookkeeping/dimension-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/dimension-rules')>()),
  fetchActiveDimensionRules: vi.fn().mockResolvedValue([]),
}))

import { createTableMockSupabase } from '@/tests/helpers'
import { classifyError } from '@/lib/errors/get-structured-error'
import type { CommitActor } from '../actor-context'
import { runWithActor } from '../actor-context-node'
import { commitAssetDepreciation, commitEntry, commitStornoOrCorrectionDraft, createJournalEntry } from '../engine'
import { UnattendedCommitLimitExceededError } from '../errors'
import { createJournalEntries } from '../journal-entry-batch'
import {
  actorUnattendedCeiling,
  assertLinesWithinUnattendedCeiling,
  debitTotal,
  unattendedCeilingRefusal,
} from '../unattended-ceiling'

const KEY: CommitActor = { type: 'api_key', label: 'Bokföringsrobot', unattendedCommitLimit: 10000 }

/** A draft whose lines debit `debits`, and a commit RPC that posts it. */
function supabaseWithDraft(debits: number[]) {
  return createTableMockSupabase({
    journal_entry_lines: [
      { data: debits.map((debit_amount, i) => ({ id: `line-${i}`, debit_amount })) },
      { data: [] },
    ],
    journal_entries: { data: { id: 'je-1', status: 'posted', lines: [] } },
    'rpc:commit_journal_entry': { data: [{ voucher_number: 7 }] },
  })
}

const lines = (amount: number) => [
  { account_number: '5410', debit_amount: amount, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: amount },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the ceiling binding an actor', () => {
  it('binds only a key credential with a positive limit', () => {
    expect(actorUnattendedCeiling(KEY)).toBe(10000)
    expect(actorUnattendedCeiling({ type: 'mcp_oauth', unattendedCommitLimit: 500 })).toBe(500)
    expect(actorUnattendedCeiling({ type: 'service_account', unattendedCommitLimit: 500 })).toBe(500)
    expect(actorUnattendedCeiling({ type: 'api_key' })).toBeNull()
    expect(actorUnattendedCeiling({ type: 'api_key', unattendedCommitLimit: null })).toBeNull()
    // A person, cron or the assistant is never bound, whatever it carries.
    for (const type of ['user', 'cron', 'system', 'agent_chat'] as const) {
      expect(actorUnattendedCeiling({ type, unattendedCommitLimit: 1 })).toBeNull()
    }
    expect(actorUnattendedCeiling(undefined)).toBeNull()
  })

  it('refuses above the ceiling and lets the ceiling itself through', () => {
    expect(unattendedCeilingRefusal(10000.01, KEY)).toMatchObject({ attempted: 10000.01, limit: 10000 })
    expect(unattendedCeilingRefusal(10000, KEY)).toBeNull()
    expect(unattendedCeilingRefusal(9_000_000, { type: 'user' })).toBeNull()
  })

  it('prices a verifikat on its debit side', () => {
    expect(debitTotal(lines(349.5))).toBe(349.5)
    expect(() => assertLinesWithinUnattendedCeiling(lines(12000), KEY)).toThrow(UnattendedCommitLimitExceededError)
    expect(() => assertLinesWithinUnattendedCeiling(lines(9000), KEY)).not.toThrow()
  })

  it('answers 403 with the two numbers wherever it is thrown', () => {
    expect(classifyError(new UnattendedCommitLimitExceededError(12000, 10000))).toMatchObject({
      code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED',
      details: { attempted: 12000, limit: 10000 },
    })
  })
})

describe('commitEntry', () => {
  it('refuses a 12 000 kr draft on a key capped at 10 000 without calling the commit RPC', async () => {
    const { supabase } = supabaseWithDraft([7000, 5000])

    const refused = runWithActor(KEY, () => commitEntry(supabase as never, 'co-1', 'user-1', 'je-1'))

    await expect(refused).rejects.toMatchObject({ code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', attempted: 12000, limit: 10000 })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('commits a draft within the ceiling', async () => {
    const { supabase } = supabaseWithDraft([7000, 3000])

    await runWithActor(KEY, () => commitEntry(supabase as never, 'co-1', 'user-1', 'je-1'))

    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', expect.objectContaining({ p_entry_id: 'je-1' }))
  })

  it('does not read the lines for a person, or for a key without a ceiling', async () => {
    for (const actor of [{ type: 'user' as const }, { type: 'api_key' as const, label: 'x' }]) {
      const { supabase, tables } = supabaseWithDraft([9_000_000])
      await runWithActor(actor, () => commitEntry(supabase as never, 'co-1', 'user-1', 'je-1'))
      expect(tables()).not.toContain('journal_entry_lines')
      expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', expect.anything())
    }
  })
})

describe('createJournalEntry and createJournalEntries', () => {
  const input = (amount: number) => ({
    fiscal_period_id: 'fp-1',
    entry_date: '2026-10-28',
    description: 'Kontorsmaterial',
    source_type: 'manual' as const,
    lines: lines(amount),
  })

  it('refuses before a draft is written', async () => {
    const { supabase, tables } = supabaseWithDraft([])

    await expect(
      runWithActor(KEY, () => createJournalEntry(supabase as never, 'co-1', 'user-1', input(12000))),
    ).rejects.toBeInstanceOf(UnattendedCommitLimitExceededError)
    expect(tables()).toEqual([])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses a voucher set when any voucher is above, before the first is drafted', async () => {
    const { supabase, tables } = supabaseWithDraft([])

    await expect(
      runWithActor(KEY, () =>
        createJournalEntries(supabase as never, 'co-1', 'user-1', [input(9000), input(12000)]),
      ),
    ).rejects.toBeInstanceOf(UnattendedCommitLimitExceededError)
    expect(tables()).toEqual([])
  })
})

describe('commitStornoOrCorrectionDraft', () => {
  it('answers the typed refusal for a storno above the ceiling, without calling the commit RPC', async () => {
    const { supabase } = supabaseWithDraft([25000])

    const { error } = await runWithActor(KEY, () => commitStornoOrCorrectionDraft(supabase as never, 'co-1', 'je-1'))

    expect(error).toBeInstanceOf(UnattendedCommitLimitExceededError)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('commits a storno within the ceiling', async () => {
    const { supabase } = supabaseWithDraft([2500])

    const { error } = await runWithActor(KEY, () => commitStornoOrCorrectionDraft(supabase as never, 'co-1', 'je-1'))

    expect(error).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', expect.objectContaining({ p_entry_id: 'je-1' }))
  })
})

describe('commitAssetDepreciation', () => {
  it('cancels the draft and posts nothing above the ceiling', async () => {
    const { supabase, findCalls } = supabaseWithDraft([15000])

    await expect(
      runWithActor(KEY, () =>
        commitAssetDepreciation(supabase as never, 'co-1', 'user-1', { id: 'je-1', fiscal_period_id: 'fp-1' }, {
          asset_id: 'asset-1',
          planned_depreciation: 15000,
          opening_accumulated_depreciation: 0,
          opening_depreciation_date: null,
        }),
      ),
    ).rejects.toBeInstanceOf(UnattendedCommitLimitExceededError)
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('journal_entries', 'update')).toEqual([[{ status: 'cancelled' }]])
  })
})

describe('executeYearEndClosing', () => {
  it('is refused for a key with a ceiling before anything is read or posted', async () => {
    const { executeYearEndClosing } = await import('@/lib/core/bookkeeping/year-end-service')
    const { supabase, tables } = supabaseWithDraft([])

    await expect(
      runWithActor(KEY, () => executeYearEndClosing(supabase as never, 'co-1', 'user-1', 'fp-1')),
    ).rejects.toMatchObject({ code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', attempted: null, limit: 10000 })
    expect(tables()).toEqual([])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
