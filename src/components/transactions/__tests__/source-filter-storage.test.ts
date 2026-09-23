import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SOURCE_FILTER_STORAGE_PREFIX,
  isSourceFilter,
  readStoredSourceFilter,
  writeStoredSourceFilter,
  resolveEffectiveSourceFilter,
} from '@/components/transactions/source-filter-storage'

const LEGACY_KEY = 'Accounted:transaction-source-filter:v1'

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
  vi.stubGlobal('window', { localStorage })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isSourceFilter', () => {
  it('accepts every member of the SourceFilter union', () => {
    expect(isSourceFilter('all')).toBe(true)
    expect(isSourceFilter('bank')).toBe(true)
    expect(isSourceFilter('bank:other')).toBe(true)
    expect(isSourceFilter('skatteverket')).toBe(true)
    expect(isSourceFilter('acct:2f8d1c3a')).toBe(true)
  })

  it('rejects null and unknown values', () => {
    expect(isSourceFilter(null)).toBe(false)
    expect(isSourceFilter('')).toBe(false)
    expect(isSourceFilter('everything')).toBe(false)
    expect(isSourceFilter('account:123')).toBe(false)
    expect(isSourceFilter('ALL')).toBe(false)
  })
})

describe('resolveEffectiveSourceFilter', () => {
  it('keeps the wanted filter when its id is among the items', () => {
    expect(resolveEffectiveSourceFilter('acct:a1', ['all', 'acct:a1', 'skatteverket'])).toBe(
      'acct:a1',
    )
    expect(resolveEffectiveSourceFilter('skatteverket', ['all', 'skatteverket'])).toBe(
      'skatteverket',
    )
  })

  it('falls back to all when the wanted id is missing (items still loading or source stale)', () => {
    expect(resolveEffectiveSourceFilter('acct:a1', ['all'])).toBe('all')
    expect(resolveEffectiveSourceFilter('skatteverket', ['all', 'acct:a1'])).toBe('all')
    expect(resolveEffectiveSourceFilter('bank:other', ['all', 'acct:a1'])).toBe('all')
  })

  it('passes all through regardless of items', () => {
    expect(resolveEffectiveSourceFilter('all', [])).toBe('all')
    expect(resolveEffectiveSourceFilter('all', ['all', 'acct:a1'])).toBe('all')
  })
})

describe('readStoredSourceFilter / writeStoredSourceFilter', () => {
  it('round-trips a filter under the per-company key', () => {
    stubLocalStorage()
    writeStoredSourceFilter('company-a', 'acct:a1')
    expect(readStoredSourceFilter('company-a')).toBe('acct:a1')
  })

  it('keeps companies separate: one company never reads another company value', () => {
    stubLocalStorage()
    writeStoredSourceFilter('company-a', 'acct:a1')
    writeStoredSourceFilter('company-b', 'skatteverket')
    expect(readStoredSourceFilter('company-a')).toBe('acct:a1')
    expect(readStoredSourceFilter('company-b')).toBe('skatteverket')
    expect(readStoredSourceFilter('company-c')).toBe('all')
  })

  it('returns all when the stored value is invalid', () => {
    stubLocalStorage({ [SOURCE_FILTER_STORAGE_PREFIX + 'company-a']: 'garbage' })
    expect(readStoredSourceFilter('company-a')).toBe('all')
  })

  it('returns all when localStorage throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => {
          throw new Error('denied')
        },
      },
    })
    expect(readStoredSourceFilter('company-a')).toBe('all')
    // Write must swallow the failure too.
    expect(() => writeStoredSourceFilter('company-a', 'bank')).not.toThrow()
  })

  it('returns all when window is unavailable (SSR/node)', () => {
    // No stub: vitest runs in the node environment, so window is undefined.
    expect(readStoredSourceFilter('company-a')).toBe('all')
    expect(() => writeStoredSourceFilter('company-a', 'bank')).not.toThrow()
  })

  it('removes the retired browser-wide v1 key on read and ignores its value', () => {
    const store = stubLocalStorage({ [LEGACY_KEY]: 'skatteverket' })
    expect(readStoredSourceFilter('company-a')).toBe('all')
    expect(store.has(LEGACY_KEY)).toBe(false)
  })
})
