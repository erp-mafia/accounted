import { describe, it, expect } from 'vitest'
import { fetchAllRows } from '../fetch-all'

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
})
