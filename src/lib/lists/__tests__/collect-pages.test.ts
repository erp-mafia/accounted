import { describe, it, expect, vi } from 'vitest'
import { collectPages, MAX_ROWS_PER_REQUEST } from '../collect-pages'

/** A source of `total` numbered rows that answers at most `cap` per request,
 *  like PostgREST under max_rows. */
function source(total: number, { cap = MAX_ROWS_PER_REQUEST, withCount = true } = {}) {
  const rows = Array.from({ length: total }, (_, i) => i)
  return vi.fn(async (offset: number, limit: number) => ({
    data: rows.slice(offset, offset + Math.min(limit, cap)),
    count: withCount ? total : undefined,
  }))
}

describe('collectPages', () => {
  it('collects every row past the 1,000-row request cap when everything is wanted', async () => {
    const fetchPage = source(2500)

    const result = await collectPages(fetchPage, { want: Number.POSITIVE_INFINITY })

    expect(result.data).toHaveLength(2500)
    expect(result.data[2499]).toBe(2499)
    expect(result.count).toBe(2500)
    expect(fetchPage.mock.calls).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000],
    ])
  })

  it('keeps going when the server caps a page below the chunk size and reports a count', async () => {
    const fetchPage = source(1200, { cap: 500 })

    const result = await collectPages(fetchPage, { want: Number.POSITIVE_INFINITY })

    expect(result.data).toHaveLength(1200)
    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 500, 1000])
  })

  it('stops at the wanted window and asks only for what is missing', async () => {
    const fetchPage = source(5000, { withCount: false })

    const result = await collectPages(fetchPage, { want: 1200 })

    expect(result.data).toHaveLength(1200)
    expect(result.count).toBeNull()
    expect(fetchPage.mock.calls).toEqual([
      [0, 1000],
      [1000, 200],
    ])
  })

  it('ends on a short page when the source reports no count', async () => {
    const fetchPage = source(1001, { withCount: false })

    const result = await collectPages(fetchPage, { want: 3000 })

    expect(result.data).toHaveLength(1001)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('ends on an empty page even when the reported count is higher', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({
      data: offset === 0 ? [1, 2] : [],
      count: 10,
    }))

    const result = await collectPages(fetchPage, { want: Number.POSITIVE_INFINITY, chunkSize: 2 })

    expect(result.data).toEqual([1, 2])
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('never asks for more than the request cap, whatever chunk size is passed', async () => {
    const fetchPage = source(10)

    await collectPages(fetchPage, { want: 10, chunkSize: 100000 })

    expect(fetchPage).toHaveBeenCalledWith(0, 10)
    const capped = source(3000)
    await collectPages(capped, { want: 3000, chunkSize: 100000 })
    expect(capped.mock.calls.every(([, limit]) => limit <= MAX_ROWS_PER_REQUEST)).toBe(true)
  })

  it('fails the whole collection when a page fails', async () => {
    const fetchPage = vi.fn(async (offset: number) => {
      if (offset > 0) throw new Error('HTTP 500')
      return { data: Array.from({ length: 1000 }, (_, i) => i), count: 2000 }
    })

    await expect(collectPages(fetchPage, { want: Number.POSITIVE_INFINITY })).rejects.toThrow('HTTP 500')
  })
})
