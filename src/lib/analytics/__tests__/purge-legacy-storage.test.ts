import { describe, it, expect, vi, afterEach } from 'vitest'
import { purgeLegacyAnalyticsStorage } from '../purge-legacy-storage'

/** Minimal in-memory Storage stand-in: the suite runs in a node env. */
function makeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as unknown as Storage
}

function keysOf(s: Storage): string[] {
  return Array.from({ length: s.length }, (_, i) => s.key(i)!).sort()
}

describe('purgeLegacyAnalyticsStorage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('removes the real key observed in production', () => {
    const local = makeStorage({ __recapt_record_engine: 'x' })
    vi.stubGlobal('window', { localStorage: local, sessionStorage: makeStorage() })
    expect(purgeLegacyAnalyticsStorage()).toBe(1)
    expect(keysOf(local)).toEqual([])
  })

  // The helper this replaces used startsWith('recapt'), which never matched
  // `__recapt_record_engine`. Pin the substring behaviour so it cannot regress.
  it('matches by substring, not prefix', () => {
    const local = makeStorage({
      __recapt_record_engine: 'a',
      'ph_glimt_session': 'b',
      'RECAPT_UPPER': 'c',
    })
    vi.stubGlobal('window', { localStorage: local, sessionStorage: makeStorage() })
    expect(purgeLegacyAnalyticsStorage()).toBe(3)
    expect(keysOf(local)).toEqual([])
  })

  it("leaves the app's own keys alone", () => {
    const local = makeStorage({
      'Accounted:chat-sidebar-collapsed': '1',
      'gnubok.inbox.onboarding.dismissed': '1',
      __recapt_record_engine: 'x',
    })
    vi.stubGlobal('window', { localStorage: local, sessionStorage: makeStorage() })
    expect(purgeLegacyAnalyticsStorage()).toBe(1)
    expect(keysOf(local)).toEqual([
      'Accounted:chat-sidebar-collapsed',
      'gnubok.inbox.onboarding.dismissed',
    ])
  })

  it('sweeps sessionStorage too', () => {
    const session = makeStorage({ glimt_buffer: 'x' })
    vi.stubGlobal('window', { localStorage: makeStorage(), sessionStorage: session })
    expect(purgeLegacyAnalyticsStorage()).toBe(1)
    expect(keysOf(session)).toEqual([])
  })

  // Backwards iteration matters: removeItem() re-indexes, so a forward loop
  // skips the entry after each removal.
  it('removes every match even when they are adjacent', () => {
    const local = makeStorage({ recapt_a: '1', recapt_b: '2', recapt_c: '3', keep: '4' })
    vi.stubGlobal('window', { localStorage: local, sessionStorage: makeStorage() })
    expect(purgeLegacyAnalyticsStorage()).toBe(3)
    expect(keysOf(local)).toEqual(['keep'])
  })

  it('is a no-op on a second run', () => {
    const local = makeStorage({ __recapt_record_engine: 'x' })
    vi.stubGlobal('window', { localStorage: local, sessionStorage: makeStorage() })
    purgeLegacyAnalyticsStorage()
    expect(purgeLegacyAnalyticsStorage()).toBe(0)
  })

  it('never throws when storage is unavailable (private mode)', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError')
      },
      get sessionStorage(): Storage {
        throw new Error('SecurityError')
      },
    })
    expect(() => purgeLegacyAnalyticsStorage()).not.toThrow()
  })

  it('returns 0 on the server', () => {
    vi.stubGlobal('window', undefined)
    expect(purgeLegacyAnalyticsStorage()).toBe(0)
  })
})
