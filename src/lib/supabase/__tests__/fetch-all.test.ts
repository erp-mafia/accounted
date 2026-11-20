import { describe, it, expect } from 'vitest'
import { fetchAllRows } from '../fetch-all'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createPagedMockSupabase } from '@/tests/helpers'

const PAGE_SIZE = 1000

type Row = { id: string; value?: number }

/**
 * Build a queryFn that serves predefined pages keyed by the `from` offset.
 * Mirrors how `fetchAllRows` drives PostgREST `.range(from, to)`.
 */
function pagedQuery(pages: Record<number, Row[]>) {
  return ({ from }: { from: number; to: number }) =>
    Promise.resolve({ data: pages[from] ?? [], error: null })
}

function makeRows(start: number, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: String(start + i), value: 1 }))
}

describe('fetchAllRows', () => {
  it('returns a single page as-is and stops (page < PAGE_SIZE)', async () => {
    const rows = makeRows(0, 3)
    const out = await fetchAllRows<Row>(pagedQuery({ 0: rows }))
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.id)).toEqual(['0', '1', '2'])
  })

  it('paginates across multiple pages and concatenates in order', async () => {
    const page1 = makeRows(0, PAGE_SIZE) // full page → fetch continues
    const page2 = makeRows(PAGE_SIZE, 5) // partial page → stop
    const out = await fetchAllRows<Row>(pagedQuery({ 0: page1, [PAGE_SIZE]: page2 }))
    expect(out).toHaveLength(PAGE_SIZE + 5)
    expect(out[0].id).toBe('0')
    expect(out[out.length - 1].id).toBe(String(PAGE_SIZE + 4))
  })

  it('throws when the query returns an error', async () => {
    await expect(
      fetchAllRows<Row>(() => Promise.resolve({ data: null, error: { message: 'boom' } })),
    ).rejects.toThrow('boom')
  })

  it('propagates the driver SQLSTATE so a timeout stays dispatchable', async () => {
    // This is the highest-traffic error strip point in the codebase: every
    // paginated read goes through it. It used to throw `new Error(msg)`, which
    // dropped `code`, so a statement timeout (57014) reached the structured
    // error layer anonymous and resolved to UNKNOWN_ERROR instead of the
    // retryable TRANSIENT_ERROR. gnubok_query_journal failed this way 164
    // times in 60 days at a p50 of 8 110 ms.
    const failure = fetchAllRows<Row>(() =>
      Promise.resolve({
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      }),
    )
    await expect(failure).rejects.toMatchObject({ code: '57014' })
    // And the message stays verbatim: query_journal's sanitizeDbError matches
    // on the existing text.
    await expect(failure).rejects.toThrow('canceling statement due to statement timeout')
  })

  it('does not render "undefined" when the driver sends no message', async () => {
    await expect(
      fetchAllRows<Row>(() => Promise.resolve({ data: null, error: { code: '08006' } as never })),
    ).rejects.toThrow(/^(?!.*undefined).*$/)
  })

  it('returns [] when the first page is empty', async () => {
    const out = await fetchAllRows<Row>(pagedQuery({ 0: [] }))
    expect(out).toEqual([])
  })

  // ── The regression-critical behaviour: an unstable cross-page order ──
  // (a query missing a stable .order()) can return the same row on two
  // pages. This is the mechanism behind the doubled-balance bugs (#790/#791).

  it('dedupeBy drops a row duplicated across page boundaries (keeps first)', async () => {
    const page1 = makeRows(0, PAGE_SIZE) // ids 0..999
    // Unstable order: page 2 re-serves id "999" (already on page 1) plus a new id.
    const page2: Row[] = [
      { id: '999', value: 1 },
      { id: '1000', value: 1 },
    ]
    const out = await fetchAllRows<Row>(
      pagedQuery({ 0: page1, [PAGE_SIZE]: page2 }),
      { dedupeBy: (r) => r.id },
    )
    // 1001 unique ids (0..1000), the duplicate "999" removed → no doubling.
    expect(out).toHaveLength(PAGE_SIZE + 1)
    const ids = out.map((r) => r.id)
    expect(ids.filter((id) => id === '999')).toHaveLength(1)
    expect(new Set(ids).size).toBe(out.length)
  })

  it('without dedupeBy, cross-page duplicates pass through (unsafe default)', async () => {
    const page1 = makeRows(0, PAGE_SIZE)
    const page2: Row[] = [{ id: '999', value: 1 }]
    const out = await fetchAllRows<Row>(pagedQuery({ 0: page1, [PAGE_SIZE]: page2 }))
    expect(out).toHaveLength(PAGE_SIZE + 1)
    expect(out.map((r) => r.id).filter((id) => id === '999')).toHaveLength(2)
  })

  it('dedupeBy is a no-op for a single page (no cross-page duplicates possible)', async () => {
    const rows: Row[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'a' }, // an intra-page repeat is left untouched: single page is trusted
    ]
    const out = await fetchAllRows<Row>(pagedQuery({ 0: rows }), { dedupeBy: (r) => r.id })
    expect(out).toHaveLength(3)
  })

  it('maxRows stops paging once the cap is reached and returns exactly the cap', async () => {
    const pages: Record<number, Row[]> = { 0: makeRows(0, PAGE_SIZE), [PAGE_SIZE]: makeRows(PAGE_SIZE, PAGE_SIZE), [2 * PAGE_SIZE]: makeRows(2 * PAGE_SIZE, PAGE_SIZE) }
    const offsets: number[] = []
    const out = await fetchAllRows<Row>(
      (range) => {
        offsets.push(range.from)
        return pagedQuery(pages)(range)
      },
      { maxRows: 1500 },
    )
    expect(out).toHaveLength(1500)
    expect(out[1499].id).toBe('1499')
    expect(offsets).toEqual([0, PAGE_SIZE])
  })

  it('maxRows above what exists returns everything', async () => {
    const out = await fetchAllRows<Row>(pagedQuery({ 0: makeRows(0, PAGE_SIZE), [PAGE_SIZE]: makeRows(PAGE_SIZE, 1) }), { maxRows: 5000 })
    expect(out).toHaveLength(PAGE_SIZE + 1)
  })
})

describe('fetchAllRows onFirstPage', () => {
  it('hands over the first page before the rest is fetched, and still returns every row', async () => {
    const seen: Array<{ rows: number; requestedSoFar: number }> = []
    let requests = 0
    const pages: Record<number, Row[]> = { 0: makeRows(0, PAGE_SIZE), [PAGE_SIZE]: makeRows(PAGE_SIZE, 5) }
    const out = await fetchAllRows<Row>(
      ({ from }) => {
        requests += 1
        return Promise.resolve({ data: pages[from] ?? [], error: null })
      },
      { onFirstPage: (rows) => seen.push({ rows: rows.length, requestedSoFar: requests }) },
    )
    expect(seen).toEqual([{ rows: PAGE_SIZE, requestedSoFar: 1 }])
    expect(out).toHaveLength(PAGE_SIZE + 5)
    expect(out[PAGE_SIZE].id).toBe(String(PAGE_SIZE))
  })

  it('is not called when everything fits in one page', async () => {
    let calls = 0
    const out = await fetchAllRows<Row>(pagedQuery({ 0: makeRows(0, 3) }), { onFirstPage: () => (calls += 1) })
    expect(calls).toBe(0)
    expect(out).toHaveLength(3)
  })

  it('is not called when maxRows is met by the first page', async () => {
    let calls = 0
    const out = await fetchAllRows<Row>(
      pagedQuery({ 0: makeRows(0, PAGE_SIZE), [PAGE_SIZE]: makeRows(PAGE_SIZE, PAGE_SIZE) }),
      { maxRows: PAGE_SIZE, onFirstPage: () => (calls += 1) },
    )
    expect(calls).toBe(0)
    expect(out).toHaveLength(PAGE_SIZE)
  })
})

describe('fetchAllRows against PostgREST max-rows (createPagedMockSupabase)', () => {
  it('returns all 1,001 rows where a bare read stops at 1,000', async () => {
    const { supabase } = createPagedMockSupabase({ things: makeRows(0, PAGE_SIZE + 1) })
    const db = supabase as unknown as SupabaseClient

    const bare = await db.from('things').select('id')
    const paged = await fetchAllRows<Row>(({ from, to }) => db.from('things').select('id').order('id').range(from, to))

    expect(bare.data).toHaveLength(PAGE_SIZE)
    expect(paged).toHaveLength(PAGE_SIZE + 1)
  })
})
