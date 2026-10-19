/**
 * The bank side's assistant-reads plug-in point is static wiring: each member
 * hands its arguments, unchanged, to the read helper the proposals called
 * directly before the seam existed, and gives back what it returns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadReads, readIsFresh, assistantSuggestionFromRead } = vi.hoisted(() => ({
  loadReads: vi.fn(),
  readIsFresh: vi.fn(),
  assistantSuggestionFromRead: vi.fn(),
}))
vi.mock('@/lib/agent/categorize/read', () => ({ loadReads, readIsFresh, assistantSuggestionFromRead }))

import { ASSISTANT_READS } from '../assistant-reads'

describe('ASSISTANT_READS', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is frozen', () => {
    expect(Object.isFrozen(ASSISTANT_READS)).toBe(true)
  })

  it('loads, judges and turns a read into a proposal with the read helpers', async () => {
    const supabase = {} as never
    const read = { transaction_id: 'tx-1' } as never
    const tx = { id: 'tx-1' } as never
    const reads = new Map()
    const proposal = { source: 'assistant' }
    loadReads.mockResolvedValue(reads)
    readIsFresh.mockReturnValue(true)
    assistantSuggestionFromRead.mockReturnValue(proposal)

    await expect(ASSISTANT_READS.load(supabase, 'company-1', ['tx-1'])).resolves.toBe(reads)
    expect(loadReads).toHaveBeenCalledWith(supabase, 'company-1', ['tx-1'])
    expect(ASSISTANT_READS.isFresh(read, tx)).toBe(true)
    expect(readIsFresh).toHaveBeenCalledWith(read, tx)
    expect(ASSISTANT_READS.proposal(read, tx, 'aktiebolag')).toBe(proposal)
    expect(assistantSuggestionFromRead).toHaveBeenCalledWith(read, tx, 'aktiebolag')
  })
})
