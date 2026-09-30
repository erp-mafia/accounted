import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { formatLineDimensions, loadDimensionNames } from '../dimension-labels'

describe('formatLineDimensions', () => {
  const names = new Map([
    ['1', 'Kostnadsställe'],
    ['6', 'Projekt'],
  ])

  it('names each tag after its registry dimension, in SIE number order', () => {
    expect(formatLineDimensions({ '6': 'P100', '1': 'KS01' }, names)).toBe('Kostnadsställe KS01, Projekt P100')
  })

  it('keeps a tag whose number the registry does not name, as "<dim no>: <code>"', () => {
    expect(formatLineDimensions({ '20': 'X1', '1': 'KS01' }, names)).toBe('Kostnadsställe KS01, 20: X1')
  })

  it('sorts numerically, not as text', () => {
    expect(formatLineDimensions({ '10': 'A', '9': 'B' }, new Map())).toBe('9: B, 10: A')
  })

  it('is empty for an untagged line and skips blank codes', () => {
    expect(formatLineDimensions(undefined, names)).toBe('')
    expect(formatLineDimensions(null, names)).toBe('')
    expect(formatLineDimensions({}, names)).toBe('')
    expect(formatLineDimensions({ '1': '  ', '6': 'P100' }, names)).toBe('Projekt P100')
  })
})

describe('loadDimensionNames', () => {
  it('reads the registry for the company, paginated, keyed by SIE number as a string', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { sie_dim_no: 1, name: 'Kostnadsställe' },
        { sie_dim_no: 20, name: 'Kundsegment' },
      ],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = await loadDimensionNames(supabase as any, 'company-1')

    expect([...names]).toEqual([
      ['1', 'Kostnadsställe'],
      ['20', 'Kundsegment'],
    ])
    expect(findCalls('dimensions', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCall('dimensions', 'range')).toEqual([0, 999])
  })

  it('throws when the registry read fails instead of labelling with bare numbers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(loadDimensionNames(supabase as any, 'company-1')).rejects.toThrow('boom')
  })
})
