import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/route-from-arkiv', () => ({
  routeStaleQueueItems: vi.fn(),
  requeueHiddenRoutedItems: vi.fn(),
}))

import { runInboxSweep, PROCESSING_STUCK_MS } from '../lib/sweep'
import { emptyResult } from '../lib/extract-invoice-fields'
import { requeueHiddenRoutedItems, routeStaleQueueItems } from '../lib/route-from-arkiv'

/**
 * The staged-upload crash recovery: only rows that are (a) still
 * 'processing', (b) older than the stuck threshold, and (c) still carrying a
 * NULL extracted_data are flipped, and the flip writes the same empty
 * skeleton the synchronous swallow-failure path persists. No re-extraction.
 */

interface Captured {
  selectFilters: Array<{ method: string; args: unknown[] }>
  updatePayload?: Record<string, unknown>
  updateFilters: Array<{ method: string; args: unknown[] }>
}

function makeSupabase(opts: {
  staleIds: string[]
  claimedIds?: string[]
  selectError?: { message: string }
  updateError?: { message: string }
}) {
  const captured: Captured = { selectFilters: [], updateFilters: [] }

  const selectChain = {
    eq: vi.fn((...args: unknown[]) => {
      captured.selectFilters.push({ method: 'eq', args })
      return selectChain
    }),
    lt: vi.fn((...args: unknown[]) => {
      captured.selectFilters.push({ method: 'lt', args })
      return selectChain
    }),
    limit: vi.fn().mockResolvedValue(
      opts.selectError
        ? { data: null, error: opts.selectError }
        : { data: opts.staleIds.map((id) => ({ id })), error: null },
    ),
  }

  const updateChain = {
    in: vi.fn((...args: unknown[]) => {
      captured.updateFilters.push({ method: 'in', args })
      return updateChain
    }),
    eq: vi.fn((...args: unknown[]) => {
      captured.updateFilters.push({ method: 'eq', args })
      return updateChain
    }),
    is: vi.fn((...args: unknown[]) => {
      captured.updateFilters.push({ method: 'is', args })
      return updateChain
    }),
    select: vi.fn().mockResolvedValue(
      opts.updateError
        ? { data: null, error: opts.updateError }
        : { data: (opts.claimedIds ?? opts.staleIds).map((id) => ({ id })), error: null },
    ),
  }

  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => selectChain),
      update: vi.fn((payload: Record<string, unknown>) => {
        captured.updatePayload = payload
        return updateChain
      }),
    })),
  }

  return { supabase: supabase as never, captured }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(routeStaleQueueItems).mockResolvedValue(0)
  vi.mocked(requeueHiddenRoutedItems).mockResolvedValue(0)
})

describe('runInboxSweep', () => {
  it('flips stale processing rows to received with the empty skeleton', async () => {
    const { supabase, captured } = makeSupabase({ staleIds: ['i1', 'i2'] })

    const summary = await runInboxSweep(supabase)

    expect(summary).toEqual({ flipped: 2, routed: 0, requeued: 0 })
    // The stale scan targets processing rows older than the threshold.
    expect(captured.selectFilters).toEqual([
      { method: 'eq', args: ['status', 'processing'] },
      { method: 'lt', args: ['created_at', expect.any(String)] },
    ])
    const cutoff = new Date(captured.selectFilters[1].args[1] as string).getTime()
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(PROCESSING_STUCK_MS - 1000)
    // The flip is a guarded claim: status still processing, data still NULL.
    expect(captured.updateFilters).toEqual([
      { method: 'in', args: ['id', ['i1', 'i2']] },
      { method: 'eq', args: ['status', 'processing'] },
      { method: 'is', args: ['extracted_data', null] },
    ])
    expect(captured.updatePayload).toEqual({
      status: 'received',
      extracted_data: emptyResult(),
      extraction_skipped: false,
    })
  })

  it('counts only the rows the guarded update actually claimed', async () => {
    // A worker finished i2 between the scan and the flip: its result wins.
    const { supabase } = makeSupabase({ staleIds: ['i1', 'i2'], claimedIds: ['i1'] })

    const summary = await runInboxSweep(supabase)

    expect(summary).toEqual({ flipped: 1, routed: 0, requeued: 0 })
  })

  it('does nothing when no processing row is stale', async () => {
    const { supabase, captured } = makeSupabase({ staleIds: [] })

    const summary = await runInboxSweep(supabase)

    expect(summary).toEqual({ flipped: 0, routed: 0, requeued: 0 })
    expect(captured.updatePayload).toBeUndefined()
  })

  it('never throws: a failed select reports zero flips', async () => {
    const { supabase } = makeSupabase({ staleIds: [], selectError: { message: 'boom' } })

    await expect(runInboxSweep(supabase)).resolves.toEqual({ flipped: 0, routed: 0, requeued: 0 })
  })

  it('never throws: a failed update reports zero flips', async () => {
    const { supabase } = makeSupabase({ staleIds: ['i1'], updateError: { message: 'boom' } })

    await expect(runInboxSweep(supabase)).resolves.toEqual({ flipped: 0, routed: 0, requeued: 0 })
  })

  it('brings routed rows back to Underlag and routes stale ones on every pass', async () => {
    const { supabase } = makeSupabase({ staleIds: [] })
    vi.mocked(requeueHiddenRoutedItems).mockResolvedValue(3)
    vi.mocked(routeStaleQueueItems).mockResolvedValue(1)

    await expect(runInboxSweep(supabase)).resolves.toEqual({ flipped: 0, routed: 1, requeued: 3 })
    expect(requeueHiddenRoutedItems).toHaveBeenCalledWith(supabase)
    expect(routeStaleQueueItems).toHaveBeenCalledWith(supabase)
  })

  it('never throws: a failed requeue still lets the routing run', async () => {
    const { supabase } = makeSupabase({ staleIds: [] })
    vi.mocked(requeueHiddenRoutedItems).mockRejectedValue(new Error('boom'))
    vi.mocked(routeStaleQueueItems).mockResolvedValue(2)

    await expect(runInboxSweep(supabase)).resolves.toEqual({ flipped: 0, routed: 2, requeued: 0 })
  })
})
