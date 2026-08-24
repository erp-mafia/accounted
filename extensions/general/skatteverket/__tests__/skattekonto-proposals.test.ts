import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const bulkMock = vi.fn()
vi.mock('../lib/skattekonto-match', () => ({
  findMatchSuggestionsBulk: (...args: unknown[]) => bulkMock(...args),
}))

import { refreshSkattekontoProposals } from '../lib/skattekonto-proposals'

const COMPANY = 'company-1'

function openRow(id: string, suggested: string | null = null) {
  return {
    id,
    transaktionsdatum: '2026-08-12',
    transaktionstext: 'Inbetalning bokförd',
    belopp_skatteverket: 30000,
    journal_entry_id: null,
    suggested_journal_entry_id: suggested,
  }
}

describe('refreshSkattekontoProposals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bulkMock.mockReset()
  })

  it('writes new proposals, clears stale ones and leaves unchanged rows alone', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: [openRow('r-new'), openRow('r-stale', 'E-old'), openRow('r-same', 'E-same')] })
    bulkMock.mockResolvedValue(
      new Map([
        ['r-new', { journal_entry_id: 'E-new' }],
        ['r-same', { journal_entry_id: 'E-same' }],
      ]),
    )
    enqueue({ data: null }) // update r-new
    enqueue({ data: null }) // update r-stale

    const result = await refreshSkattekontoProposals(supabase as never, COMPANY)

    expect(result).toEqual({ considered: 3, proposed: 1, cleared: 1, unchanged: 1 })
    const updates = findCalls('skattekonto_transactions', 'update')
    expect(updates).toHaveLength(2)
    expect(updates[0][0]).toMatchObject({ suggested_journal_entry_id: 'E-new' })
    expect((updates[0][0] as { suggested_at: string | null }).suggested_at).toBeTruthy()
    expect(updates[1][0]).toEqual({ suggested_journal_entry_id: null, suggested_at: null })
    // Only still-open rows may receive a proposal: the write is guarded on journal_entry_id IS NULL.
    const isCalls = calls.filter((c) => c.table === 'skattekonto_transactions' && c.method === 'is')
    expect(isCalls.every((c) => c.args[0] === 'journal_entry_id' && c.args[1] === null)).toBe(true)
    // Only open, non-ignored, SKV-posted rows are considered.
    expect(findCalls('skattekonto_transactions', 'eq')).toContainEqual(['status', 'booked'])
    expect(findCalls('skattekonto_transactions', 'eq')).toContainEqual(['is_ignored', false])
  })

  it('returns zeros and never throws when the row read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })
    await expect(refreshSkattekontoProposals(supabase as never, COMPANY)).resolves.toEqual({
      considered: 0,
      proposed: 0,
      cleared: 0,
      unchanged: 0,
    })
    expect(bulkMock).not.toHaveBeenCalled()
  })

  it('skips the matcher entirely when there are no open rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const result = await refreshSkattekontoProposals(supabase as never, COMPANY)
    expect(result.considered).toBe(0)
    expect(bulkMock).not.toHaveBeenCalled()
  })
})
