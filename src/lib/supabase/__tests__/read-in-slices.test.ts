import { describe, expect, it } from 'vitest'
import { readInSlices } from '../read-in-slices'

const ids = (count: number) => Array.from({ length: count }, (_, i) => `id-${i + 1}`)

/** A read that answers one row per id and records the slices it was asked for. */
function recorder(fail?: (slice: string[], index: number) => 'error' | 'throw' | null) {
  const slices: string[][] = []
  const read = async (slice: string[]) => {
    const index = slices.push(slice) - 1
    const failure = fail?.(slice, index) ?? null
    if (failure === 'throw') throw new Error('canceling statement due to statement timeout')
    if (failure === 'error') return { data: null, error: { message: 'Request-URI Too Large' } }
    return { data: slice.map((id) => ({ id })), error: null }
  }
  return { read, slices }
}

describe('readInSlices', () => {
  it('sends nothing for an empty list', async () => {
    const { read, slices } = recorder()

    expect(await readInSlices(ids(0), read)).toEqual({ data: [], error: null })
    expect(slices).toEqual([])
  })

  it('reads 100 ids in one slice and 101 in two, the rows in slice order', async () => {
    const one = recorder()
    expect((await readInSlices<{ id: string }>(ids(100), one.read)).data).toHaveLength(100)
    expect(one.slices.map((s) => s.length)).toEqual([100])

    const two = recorder()
    const { data, error } = await readInSlices<{ id: string }>(ids(101), two.read)
    expect(error).toBeNull()
    expect(two.slices.map((s) => s.length)).toEqual([100, 1])
    expect(data.map((r) => r.id)).toEqual(ids(101))
  })

  it('answers with the first failed slice and no rows, and reads no further', async () => {
    const { read, slices } = recorder((_slice, index) => (index === 1 ? 'error' : null))

    expect(await readInSlices(ids(250), read)).toEqual({ data: [], error: { message: 'Request-URI Too Large' } })
    expect(slices).toHaveLength(2)
  })

  it('answers a slice that throws as its error', async () => {
    const { read } = recorder(() => 'throw')

    const { data, error } = await readInSlices(ids(5), read)

    expect(data).toEqual([])
    expect(error?.message).toBe('canceling statement due to statement timeout')
  })
})
