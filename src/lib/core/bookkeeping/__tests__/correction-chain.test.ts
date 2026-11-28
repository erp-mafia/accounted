import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  correctedOriginalOf,
  correctionChainDepth,
  CORRECTION_CHAIN_GUARD_DEPTH,
  liveEntryOf,
  MAX_CHAIN_WALK,
} from '../correction-chain'

// Mock supabase: each .single() call resolves the next queued result and
// records the id filtered on, so tests can assert exactly which parents were
// fetched.
let results: Array<{ data?: unknown; error?: unknown }>
let fetchedIds: string[]

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn().mockReturnValue(b)
      b.eq = vi.fn().mockImplementation((col: string, value: string) => {
        if (col === 'id') fetchedIds.push(value)
        return b
      })
      b.single = vi.fn().mockImplementation(async () => results.shift() ?? { data: null, error: null })
      return b
    }),
  }
}

function row(
  id: string,
  parent: { correction_of_id?: string | null; reverses_id?: string | null } = {},
  voucher: { series?: string; number?: number } = {}
) {
  return {
    data: {
      id,
      correction_of_id: parent.correction_of_id ?? null,
      reverses_id: parent.reverses_id ?? null,
      voucher_series: voucher.series ?? 'A',
      voucher_number: voucher.number ?? 1,
    },
    error: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  results = []
  fetchedIds = []
})

describe('correctionChainDepth', () => {
  it('returns depth 0 with zero queries for an unchained entry', async () => {
    const supabase = makeClient()
    const info = await correctionChainDepth(supabase as never, 'company-1', {
      id: 'orig-1',
      correction_of_id: null,
      reverses_id: null,
    })
    expect(info).toEqual({ depth: 0, rootVoucher: null })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('walks correction_of_id links to the root and reports its voucher', async () => {
    // target(c3) → c2 → c1 → orig (root, voucher A7)
    results = [
      row('c2', { correction_of_id: 'c1' }, { number: 4 }),
      row('c1', { correction_of_id: 'orig' }, { number: 3 }),
      row('orig', {}, { series: 'A', number: 7 }),
    ]
    const supabase = makeClient()
    const info = await correctionChainDepth(supabase as never, 'company-1', {
      id: 'c3',
      correction_of_id: 'c2',
      reverses_id: null,
    })
    expect(info).toEqual({ depth: 3, rootVoucher: 'A7' })
    expect(fetchedIds).toEqual(['c2', 'c1', 'orig'])
  })

  it('follows reverses_id when correction_of_id is absent (storno links)', async () => {
    results = [row('orig', {}, { series: 'B', number: 12 })]
    const supabase = makeClient()
    const info = await correctionChainDepth(supabase as never, 'company-1', {
      id: 'storno-1',
      correction_of_id: null,
      reverses_id: 'orig',
    })
    expect(info).toEqual({ depth: 1, rootVoucher: 'B12' })
  })

  it('stops on a broken link (parent not found)', async () => {
    results = [
      row('c1', { correction_of_id: 'gone' }),
      { data: null, error: { message: 'not found' } },
    ]
    const supabase = makeClient()
    const info = await correctionChainDepth(supabase as never, 'company-1', {
      id: 'c2',
      correction_of_id: 'c1',
      reverses_id: null,
    })
    expect(info.depth).toBe(1)
    // The walk never reached a parentless node, so no voucher may be
    // presented as the chain root.
    expect(info.rootVoucher).toBeNull()
  })

  it('terminates on a cyclic chain instead of looping', async () => {
    // a → b → a (cycle). The walk must stop when it re-encounters a.
    results = [
      row('b', { correction_of_id: 'a' }),
      row('a', { correction_of_id: 'b' }),
    ]
    const supabase = makeClient()
    const info = await correctionChainDepth(supabase as never, 'company-1', {
      id: 'a',
      correction_of_id: 'b',
      reverses_id: null,
    })
    expect(info.depth).toBeLessThanOrEqual(2)
  })

  it('caps the walk at MAX_CHAIN_WALK hops', async () => {
    for (let i = 0; i < MAX_CHAIN_WALK + 5; i++) {
      results.push(row(`e${i}`, { correction_of_id: `e${i + 1}` }))
    }
    const supabase = makeClient()
    const info = await correctionChainDepth(supabase as never, 'company-1', {
      id: 'start',
      correction_of_id: 'e0',
      reverses_id: null,
    })
    expect(info.depth).toBe(MAX_CHAIN_WALK)
    expect(fetchedIds).toHaveLength(MAX_CHAIN_WALK)
    // Capped before reaching the root: the last node still has a parent.
    expect(info.rootVoucher).toBeNull()
  })

  it('guard threshold is 3: original → rättelse → rättelse-av-rättelse stays allowed', () => {
    // Locked by the plan: depth 2 targets (fixing the fix) pass the guard,
    // depth 3+ requires the explicit override.
    expect(CORRECTION_CHAIN_GUARD_DEPTH).toBe(3)
  })
})

describe('correctedOriginalOf', () => {
  function sourced(
    id: string,
    links: { correction_of_id?: string | null; reverses_id?: string | null },
    source: { source_type: string; source_id: string | null },
  ) {
    const base = row(id, links)
    return { data: { ...(base.data as object), ...source }, error: null }
  }

  it('answers the verifikat a correction corrects, with its source columns, in one read', async () => {
    results = [sourced('orig', {}, { source_type: 'supplier_invoice_registered', source_id: 'si-1' })]
    const supabase = makeClient()
    const root = await correctedOriginalOf(supabase as never, 'company-1', { id: 'c1', correction_of_id: 'orig' })
    expect(root).toEqual({ id: 'orig', source_type: 'supplier_invoice_registered', source_id: 'si-1' })
    expect(fetchedIds).toEqual(['orig'])
  })

  it('follows a correction of a correction back to the first verifikat that corrects nothing', async () => {
    results = [
      sourced('c1', { correction_of_id: 'orig' }, { source_type: 'correction', source_id: null }),
      sourced('orig', {}, { source_type: 'invoice_paid', source_id: 'inv-1' }),
    ]
    const supabase = makeClient()
    const root = await correctedOriginalOf(supabase as never, 'company-1', { id: 'c2', correction_of_id: 'c1' })
    expect(root).toEqual({ id: 'orig', source_type: 'invoice_paid', source_id: 'inv-1' })
    expect(fetchedIds).toEqual(['c1', 'orig'])
  })

  it('ends at a storno a correction corrects, without following its reverses_id', async () => {
    results = [sourced('storno-1', { reverses_id: 'orig' }, { source_type: 'storno', source_id: 'si-1' })]
    const supabase = makeClient()
    const root = await correctedOriginalOf(supabase as never, 'company-1', { id: 'c1', correction_of_id: 'storno-1' })
    expect(root).toEqual({ id: 'storno-1', source_type: 'storno', source_id: 'si-1' })
    expect(fetchedIds).toEqual(['storno-1'])
  })

  it('answers null when the parent is not found', async () => {
    results = [{ data: null, error: { message: 'no rows', code: 'PGRST116' } }]
    const supabase = makeClient()
    expect(await correctedOriginalOf(supabase as never, 'company-1', { id: 'c1', correction_of_id: 'gone' })).toBeNull()
  })

  it('throws when a read fails, so a refusal is not skipped on a guess', async () => {
    results = [{ data: null, error: { message: 'timeout', code: '57014' } }]
    const supabase = makeClient()
    await expect(correctedOriginalOf(supabase as never, 'company-1', { id: 'c1', correction_of_id: 'orig' })).rejects.toThrow(
      'timeout',
    )
  })

  it('answers null when the walk is capped before the root', async () => {
    for (let i = 0; i < MAX_CHAIN_WALK + 5; i++) {
      results.push(sourced(`e${i}`, { correction_of_id: `e${i + 1}` }, { source_type: 'correction', source_id: null }))
    }
    const supabase = makeClient()
    expect(await correctedOriginalOf(supabase as never, 'company-1', { id: 'start', correction_of_id: 'e0' })).toBeNull()
    expect(fetchedIds).toHaveLength(MAX_CHAIN_WALK)
  })
})

describe('liveEntryOf', () => {
  it('answers a posted verifikat with itself, in one read', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'e1', status: 'posted' } }])

    expect(await liveEntryOf(supabase as never, 'company-1', 'e1')).toEqual({ id: 'e1' })
  })

  it('follows a rättelse of a rättelse to the posted correction', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'e1', status: 'reversed' } },
      { data: [{ id: 'c1' }] },
      { data: { id: 'c1', status: 'reversed' } },
      { data: [{ id: 'c2' }] },
      { data: { id: 'c2', status: 'posted' } },
    ])

    expect(await liveEntryOf(supabase as never, 'company-1', 'e1')).toEqual({ id: 'c2' })
  })

  it('answers none for a storno without a correction: nothing stands for the verifikat', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'e1', status: 'reversed' } },
      { data: [] },
    ])

    expect(await liveEntryOf(supabase as never, 'company-1', 'e1')).toEqual({ none: true })
  })

  it('answers exhausted when the shared hop budget runs out', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'e1', status: 'reversed' } },
      { data: [{ id: 'c1' }] },
    ])

    expect(await liveEntryOf(supabase as never, 'company-1', 'e1', { hops: 1 })).toEqual({ exhausted: true })
  })
})
