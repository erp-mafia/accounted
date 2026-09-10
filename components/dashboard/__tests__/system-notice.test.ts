import { describe, it, expect } from 'vitest'
import {
  SYSTEM_NOTICE_STORAGE_KEY,
  dismissSystemNotice,
  isSystemNoticeDismissed,
  parseSystemNoticeUntil,
} from '../system-notice'

const NOW = Date.parse('2026-09-10T12:00:00+02:00')

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    map,
  }
}

describe('parseSystemNoticeUntil', () => {
  it('returns the deadline while it is in the future', () => {
    expect(parseSystemNoticeUntil('2026-09-10T23:00:00+02:00', NOW)).toBe(
      Date.parse('2026-09-10T23:00:00+02:00'),
    )
    expect(parseSystemNoticeUntil('  2026-09-10T23:00:00+02:00  ', NOW)).not.toBeNull()
  })

  it('returns null once the deadline has passed, or at the exact instant', () => {
    expect(parseSystemNoticeUntil('2026-09-10T11:00:00+02:00', NOW)).toBeNull()
    expect(parseSystemNoticeUntil('2026-09-10T12:00:00+02:00', NOW)).toBeNull()
  })

  it('returns null for unset, blank, or unparseable values', () => {
    expect(parseSystemNoticeUntil(undefined, NOW)).toBeNull()
    expect(parseSystemNoticeUntil(null, NOW)).toBeNull()
    expect(parseSystemNoticeUntil('', NOW)).toBeNull()
    expect(parseSystemNoticeUntil('   ', NOW)).toBeNull()
    expect(parseSystemNoticeUntil('tonight', NOW)).toBeNull()
  })
})

describe('dismissal', () => {
  const until = Date.parse('2026-09-10T23:00:00+02:00')

  it('is not dismissed until the user closes it, then stays closed for that deadline', () => {
    const storage = memoryStorage()
    expect(isSystemNoticeDismissed(storage, until)).toBe(false)
    dismissSystemNotice(storage, until)
    expect(storage.map.get(SYSTEM_NOTICE_STORAGE_KEY)).toBe(String(until))
    expect(isSystemNoticeDismissed(storage, until)).toBe(true)
  })

  it('shows a later notice again: the dismissal is keyed by deadline', () => {
    const storage = memoryStorage({ [SYSTEM_NOTICE_STORAGE_KEY]: String(until) })
    expect(isSystemNoticeDismissed(storage, until + 86_400_000)).toBe(false)
  })

  it('treats missing or throwing storage as not dismissed', () => {
    expect(isSystemNoticeDismissed(null, until)).toBe(false)
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(isSystemNoticeDismissed(throwing, until)).toBe(false)
    expect(() => dismissSystemNotice(throwing, until)).not.toThrow()
  })
})
