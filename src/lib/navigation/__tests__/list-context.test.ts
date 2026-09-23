import { describe, it, expect } from 'vitest'
import {
  computeNeighbors,
  listContextKey,
  readListContext,
  writeListContext,
  type ListContext,
} from '@/lib/navigation/list-context'

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

describe('listContextKey', () => {
  it('builds a company-scoped key', () => {
    expect(listContextKey('invoices', 'c-1')).toBe('Accounted:list-context:invoices:c-1')
  })

  it('falls back to default when no company id exists', () => {
    expect(listContextKey('invoices', null)).toBe('Accounted:list-context:invoices:default')
    expect(listContextKey('invoices', undefined)).toBe('Accounted:list-context:invoices:default')
  })
})

describe('writeListContext / readListContext', () => {
  it('round-trips a context', () => {
    const storage = makeStorage()
    const context: ListContext = { ids: ['a', 'b', 'c'] }
    writeListContext('key', context, storage)
    expect(readListContext('key', storage)).toEqual(context)
  })

  it('returns null when nothing was written', () => {
    expect(readListContext('missing', makeStorage())).toBeNull()
  })

  it('returns null on garbage JSON', () => {
    const storage = makeStorage({ key: '{not json' })
    expect(readListContext('key', storage)).toBeNull()
  })

  it('returns null on valid JSON with the wrong shape', () => {
    expect(readListContext('key', makeStorage({ key: '"a string"' }))).toBeNull()
    expect(readListContext('key', makeStorage({ key: 'null' }))).toBeNull()
    expect(readListContext('key', makeStorage({ key: '{"ids":"nope"}' }))).toBeNull()
    expect(readListContext('key', makeStorage({ key: '{"ids":["a",1]}' }))).toBeNull()
    expect(readListContext('key', makeStorage({ key: '{"other":["a"]}' }))).toBeNull()
  })

  it('tolerates extra properties, so contexts stored by older builds still parse', () => {
    // Older builds wrote a listPath field alongside ids.
    const stored = makeStorage({ key: '{"ids":["a","b"],"listPath":"/invoices"}' })
    expect(readListContext('key', stored)).toEqual({ ids: ['a', 'b'] })
  })

  it('keeps keys isolated from each other', () => {
    const storage = makeStorage()
    writeListContext(listContextKey('invoices', 'c-1'), { ids: ['inv-1'] }, storage)
    writeListContext(listContextKey('supplier-invoices', 'c-1'), { ids: ['sup-1'] }, storage)
    writeListContext(listContextKey('invoices', 'c-2'), { ids: ['inv-9'] }, storage)
    expect(readListContext(listContextKey('invoices', 'c-1'), storage)?.ids).toEqual(['inv-1'])
    expect(readListContext(listContextKey('supplier-invoices', 'c-1'), storage)?.ids).toEqual([
      'sup-1',
    ])
    expect(readListContext(listContextKey('invoices', 'c-2'), storage)?.ids).toEqual(['inv-9'])
  })

  it('does not throw when storage is unavailable', () => {
    expect(() => writeListContext('key', { ids: [] }, null)).not.toThrow()
    expect(readListContext('key', null)).toBeNull()
  })

  it('swallows setItem failures (quota exceeded)', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => writeListContext('key', { ids: ['a'] }, storage)).not.toThrow()
  })
})

describe('computeNeighbors', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('finds both neighbors in the middle of the list', () => {
    expect(computeNeighbors(ids, 'b')).toEqual({
      prevId: 'a',
      nextId: 'c',
      index: 2,
      total: 4,
    })
  })

  it('has no prev at the start', () => {
    expect(computeNeighbors(ids, 'a')).toEqual({
      prevId: null,
      nextId: 'b',
      index: 1,
      total: 4,
    })
  })

  it('has no next at the end', () => {
    expect(computeNeighbors(ids, 'd')).toEqual({
      prevId: 'c',
      nextId: null,
      index: 4,
      total: 4,
    })
  })

  it('handles a single-record list', () => {
    expect(computeNeighbors(['only'], 'only')).toEqual({
      prevId: null,
      nextId: null,
      index: 1,
      total: 1,
    })
  })

  it('returns null when the record is not in the context (stale/foreign context)', () => {
    expect(computeNeighbors(ids, 'zzz')).toBeNull()
    expect(computeNeighbors([], 'a')).toBeNull()
  })
})
