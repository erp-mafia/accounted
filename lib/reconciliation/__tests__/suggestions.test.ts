/**
 * Tests for confirm/reject of persisted journal-entry match suggestions.
 *
 * The contract under test: every pair is revalidated server-side at confirm
 * time (row state, voucher consumption, and the voucher's bank-leg amount and
 * direction), stale pairs are skipped (never failing the batch), and a
 * verifikat cannot be consumed twice within one bulk confirm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { manualLinkMock } = vi.hoisted(() => ({ manualLinkMock: vi.fn() }))

vi.mock('../bank-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bank-reconciliation')>()
  return { ...actual, manualLink: manualLinkMock }
})

const { logMatchEventMock } = vi.hoisted(() => ({ logMatchEventMock: vi.fn() }))
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: (...args: unknown[]) => logMatchEventMock(...args),
}))

import {
  confirmJournalEntrySuggestions,
  rejectJournalEntrySuggestions,
} from '../suggestions'

/** Queue-based chainable supabase stub, same pattern as the reconciliation
 *  suite: each awaited chain consumes the next queued result. */
function createQueueMockSupabase() {
  const resultQueue: { data: unknown; error: unknown }[] = []
  const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
    for (const r of results) {
      resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
    }
  }
  const buildChain = (): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const next = resultQueue.shift() ?? { data: null, error: null }
          return (resolve: (v: unknown) => void) => resolve(next)
        }
        return (..._args: unknown[]) => buildChain()
      },
    }
    return new Proxy({}, handler)
  }
  const supabase = {
    from: vi.fn().mockImplementation(() => buildChain()),
    rpc: vi.fn().mockImplementation(() => buildChain()),
  }
  return { supabase, enqueue }
}

const TX_1 = 'tx-1'
const TX_2 = 'tx-2'
const JE_1 = 'je-1'
const CA_ID = 'ca-1'

function suggestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_1,
    amount: -1000,
    currency: 'SEK',
    journal_entry_id: null,
    potential_journal_entry_id: JE_1,
    potential_match_method: 'auto_date_range',
    potential_match_confidence: '0.85',
    cash_account_id: CA_ID,
    ...overrides,
  }
}

/** A voucher bank leg agreeing with suggestionRow's -1000 (credit = money out). */
function matchingLegs() {
  return [{ debit_amount: 0, credit_amount: 1000, currency: null, amount_in_currency: null }]
}

describe('confirmJournalEntrySuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    manualLinkMock.mockResolvedValue({ success: true })
  })

  it('confirms a valid suggestion via manualLink against the row\'s own settlement account', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow() }) // fetch tx
    enqueue({ data: [] }) // consumers of JE_1: none
    enqueue({ data: { ledger_account: '1932' } }) // cash account resolve
    enqueue({ data: matchingLegs() }) // amount revalidation legs

    const result = await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
    ])

    expect(result.confirmed).toEqual([TX_1])
    expect(result.skipped).toEqual([])
    expect(manualLinkMock).toHaveBeenCalledWith(supabase, 'company-1', TX_1, JE_1, 'user-1', '1932')
    expect(logMatchEventMock).toHaveBeenCalledWith(
      supabase,
      'user-1',
      TX_1,
      'linked_to_existing_voucher',
      expect.objectContaining({ matchMethod: 'auto_date_range', matchConfidence: 0.85 }),
    )
  })

  it('skips a transaction whose suggested verifikat is already consumed', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow() })
    enqueue({ data: [{ id: 'other-tx' }] }) // someone already settles JE_1

    const result = await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
    ])

    expect(result.confirmed).toEqual([])
    expect(result.skipped).toEqual([{ transactionId: TX_1, reason: 'voucher_consumed' }])
    expect(manualLinkMock).not.toHaveBeenCalled()
  })

  it('never fails the batch: second row suggesting the same verifikat is skipped after the first consumes it', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    // Row 1: full happy path.
    enqueue({ data: suggestionRow() })
    enqueue({ data: [] })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({ data: matchingLegs() })
    // Row 2 (fetched AFTER row 1 linked): the sibling-clear trigger has wiped
    // its suggestion, so it reads as no_suggestion.
    enqueue({ data: suggestionRow({ id: TX_2, potential_journal_entry_id: null, potential_match_method: null, potential_match_confidence: null }) })

    const result = await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
      TX_2,
    ])

    expect(result.confirmed).toEqual([TX_1])
    expect(result.skipped).toEqual([{ transactionId: TX_2, reason: 'no_suggestion' }])
    expect(manualLinkMock).toHaveBeenCalledTimes(1)
  })

  it('reports manualLink refusals as link_failed with the service message', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow() })
    enqueue({ data: [] })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({ data: matchingLegs() })
    manualLinkMock.mockResolvedValue({ success: false, error: 'Verifikationen är inte bokförd ännu.' })

    const result = await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
    ])

    expect(result.confirmed).toEqual([])
    expect(result.skipped).toEqual([
      { transactionId: TX_1, reason: 'link_failed', message: 'Verifikationen är inte bokförd ännu.' },
    ])
  })

  it('skips not-found and already-linked rows', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: null }) // TX_1 not found
    enqueue({ data: suggestionRow({ id: TX_2, journal_entry_id: 'je-existing' }) })

    const result = await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
      TX_2,
    ])

    expect(result.confirmed).toEqual([])
    expect(result.skipped).toEqual([
      { transactionId: TX_1, reason: 'not_found' },
      { transactionId: TX_2, reason: 'already_linked' },
    ])
  })

  it('resolves NULL-cash_account_id rows via the PRIMARY cash account, falling back to 1930', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow({ cash_account_id: null }) })
    enqueue({ data: [] })
    // Primary lookup: the company's primary account is 1920, so the unassigned
    // row must validate against 1920 (the sweep created the suggestion under
    // the primary's scope), never a hard-coded 1930.
    enqueue({ data: { ledger_account: '1920' } })
    enqueue({ data: matchingLegs() })

    await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [TX_1])

    expect(manualLinkMock).toHaveBeenCalledWith(supabase, 'company-1', TX_1, JE_1, 'user-1', '1920')
  })

  it('falls back to 1930 when no primary cash account exists', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow({ cash_account_id: null }) })
    enqueue({ data: [] })
    enqueue({ data: null }) // no primary row
    enqueue({ data: matchingLegs() })

    await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [TX_1])

    expect(manualLinkMock).toHaveBeenCalledWith(supabase, 'company-1', TX_1, JE_1, 'user-1', '1930')
  })

  it('skips with amount_mismatch when the voucher bank leg no longer agrees with the transaction', async () => {
    // Inline rattelse re-priced the voucher's bank leg from 1000 to 500 after
    // the suggestion was computed: status stays posted, so no invalidation
    // trigger fired. Confirm must refuse instead of asserting a false
    // correspondence (BFL 5 kap 7 §).
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow() })
    enqueue({ data: [] })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 500, currency: null, amount_in_currency: null }] })

    const result = await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
    ])

    expect(result.confirmed).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ transactionId: TX_1, reason: 'amount_mismatch' })
    expect(manualLinkMock).not.toHaveBeenCalled()
  })

  it('skips with amount_mismatch when the direction flipped', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow({ amount: 1000 }) }) // money IN
    enqueue({ data: [] })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({ data: matchingLegs() }) // credit leg = money OUT

    const result = await confirmJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
    ])

    expect(result.skipped[0]).toMatchObject({ transactionId: TX_1, reason: 'amount_mismatch' })
    expect(manualLinkMock).not.toHaveBeenCalled()
  })
})

describe('rejectJournalEntrySuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears the suggestion and logs suggestion_cleared with the previous state', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow() })
    enqueue({ data: null }) // clear update

    const result = await rejectJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
    ])

    expect(result.rejected).toEqual([TX_1])
    expect(logMatchEventMock).toHaveBeenCalledWith(
      supabase,
      'user-1',
      TX_1,
      'suggestion_cleared',
      expect.objectContaining({
        previousState: expect.objectContaining({ potential_journal_entry_id: JE_1 }),
      }),
    )
  })

  it('skips rows without a suggestion', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: suggestionRow({ potential_journal_entry_id: null }) })

    const result = await rejectJournalEntrySuggestions(supabase as never, 'company-1', 'user-1', [
      TX_1,
    ])

    expect(result.rejected).toEqual([])
    expect(result.skipped).toEqual([{ transactionId: TX_1, reason: 'no_suggestion' }])
  })
})
