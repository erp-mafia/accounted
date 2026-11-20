import { describe, it, expect, vi, beforeEach } from 'vitest'

const globalMutate = vi.fn(async (_filter: (key: unknown) => boolean) => undefined)
vi.mock('swr', () => ({
  default: vi.fn(),
  mutate: (filter: (key: unknown) => boolean) => globalMutate(filter),
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }))

import {
  BADGES_BURST_MS,
  BADGES_REFRESH_MS,
  BADGES_STALE_MS,
  WORKLIST_BADGES_SWR_OPTIONS,
  badgesAreStale,
  refreshWorklistBadges,
} from '../use-worklist-badges'

describe('worklist badges refresh policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('polls only while the tab is visible, re-reads on return to it', () => {
    expect(WORKLIST_BADGES_SWR_OPTIONS.refreshInterval).toBe(BADGES_REFRESH_MS)
    expect(BADGES_REFRESH_MS).toBe(60_000)
    expect(WORKLIST_BADGES_SWR_OPTIONS.refreshWhenHidden).toBe(false)
    expect(WORKLIST_BADGES_SWR_OPTIONS.revalidateOnFocus).toBe(true)
    expect(WORKLIST_BADGES_SWR_OPTIONS.focusThrottleInterval).toBe(BADGES_STALE_MS)
  })

  it('a navigation re-reads only stale counts', () => {
    const now = 1_000_000
    expect(badgesAreStale(now - BADGES_STALE_MS, now)).toBe(true)
    expect(badgesAreStale(now - BADGES_STALE_MS + 1, now)).toBe(false)
    // Never fetched: SWR's own mount fetch is on its way.
    expect(badgesAreStale(undefined, now)).toBe(false)
  })

  it('refreshWorklistBadges revalidates the badge keys and nothing else', () => {
    vi.useFakeTimers()
    try {
      refreshWorklistBadges()
      vi.advanceTimersByTime(BADGES_BURST_MS)
      expect(globalMutate).toHaveBeenCalledTimes(1)
      const filter = globalMutate.mock.calls[0][0]
      expect(filter(['worklist-badges', 'c1'])).toBe(true)
      expect(filter(['accounts', 'c1'])).toBe(false)
      expect(filter('worklist-badges')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a burst of row events (bulk booking, bank sync) is one refresh', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 500; i++) {
        refreshWorklistBadges()
        vi.advanceTimersByTime(10)
      }
      expect(globalMutate).not.toHaveBeenCalled()
      vi.advanceTimersByTime(BADGES_BURST_MS)
      expect(globalMutate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
