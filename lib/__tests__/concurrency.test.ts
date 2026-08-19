import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from '@/lib/concurrency'

describe('mapWithConcurrency', () => {
  it('preserves input order in the result', async () => {
    const items = [50, 10, 30, 0, 20]
    const result = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms * 2
    })
    expect(result).toEqual([100, 20, 60, 0, 40])
  })

  it('never runs more than `limit` workers at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('processes every item exactly once', async () => {
    const seen: number[] = []
    await mapWithConcurrency(Array.from({ length: 13 }, (_, i) => i), 5, async (i) => {
      seen.push(i)
    })
    expect(seen.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i))
  })

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })

  it('caps the pool at the item count', async () => {
    // 2 items with limit 10 must not spin up idle workers that read past the
    // end; the result stays correct.
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n + 1)).toEqual([2, 3])
  })

  it('passes the item index to the worker', async () => {
    const idx = await mapWithConcurrency(['a', 'b', 'c'], 2, async (_item, i) => i)
    expect(idx).toEqual([0, 1, 2])
  })

  it('rejects the whole map when a worker rejects (Promise.all semantics)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })

  it('rejects a non-positive limit instead of hanging', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(
      'limit must be >= 1',
    )
  })
})
