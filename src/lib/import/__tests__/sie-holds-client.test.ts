import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVisiblePoller } from '@/lib/browser/visible-poller'
import {
  announceSIEHoldsChanged,
  fetchSIEHolds,
  onSIEHoldsChanged,
  sieHoldPollInterval,
  sieHoldStaleAfter,
  SIE_HOLD_IDLE_STALE_MS,
  SIE_HOLD_POLL_MS,
  SIE_HOLD_RETRY_MS,
  SIE_HOLD_REVIEW_STALE_MS,
  type HeldPeriod,
} from '@/lib/import/sie-holds-client'

const period = (overrides: Partial<HeldPeriod> = {}): HeldPeriod => ({
  id: 'period-1',
  name: '2025',
  import_hold: null,
  opening_balance_review_token: null,
  opening_balance_entry_id: null,
  ...overrides,
})

describe('SIE hold schedule', () => {
  it('follows a hold every 5 s', () => {
    const held = [period({ import_hold: 'import-1' })]
    expect(sieHoldPollInterval(held)).toBe(SIE_HOLD_POLL_MS)
    expect(sieHoldStaleAfter(held)).toBe(SIE_HOLD_POLL_MS)
  })

  it('keeps no timer for a review alone and refetches on a nudge after a minute', () => {
    const review = [period({ opening_balance_review_token: 'token' })]
    expect(sieHoldPollInterval(review)).toBeNull()
    expect(sieHoldStaleAfter(review)).toBe(SIE_HOLD_REVIEW_STALE_MS)
  })

  it('keeps no timer when nothing is on screen and refetches on a nudge after five minutes', () => {
    expect(sieHoldPollInterval([])).toBeNull()
    expect(sieHoldStaleAfter([])).toBe(SIE_HOLD_IDLE_STALE_MS)
    expect(sieHoldPollInterval(undefined)).toBeNull()
    expect(sieHoldStaleAfter(undefined)).toBe(SIE_HOLD_IDLE_STALE_MS)
  })
})

describe('the banner schedule over a working day', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T08:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('costs one request per five minutes of clicking around instead of one per navigation and minute', async () => {
    const load = vi.fn(async (): Promise<HeldPeriod[]> => [])
    const poller = createVisiblePoller({
      load,
      onResult: () => {},
      intervalMs: sieHoldPollInterval,
      staleAfterMs: sieHoldStaleAfter,
      retryMs: SIE_HOLD_RETRY_MS,
      isVisible: () => true,
    })
    poller.refresh()
    // One hour, a navigation every 30 s.
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
      poller.nudge()
    }
    await vi.advanceTimersByTimeAsync(0)
    // Mount plus one per elapsed five minutes; the old banner made 1 + 120 + 60.
    expect(load).toHaveBeenCalledTimes(13)
    poller.stop()
  })

  it('switches to 5 s polling when a started import is announced, and back when it ends', async () => {
    let answer: HeldPeriod[] = []
    const load = vi.fn(async () => answer)
    const poller = createVisiblePoller({
      load,
      onResult: () => {},
      intervalMs: sieHoldPollInterval,
      staleAfterMs: sieHoldStaleAfter,
      retryMs: SIE_HOLD_RETRY_MS,
      isVisible: () => true,
    })
    const unsubscribe = onSIEHoldsChanged(poller.refresh)
    poller.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)

    answer = [period({ import_hold: 'import-1' })]
    announceSIEHoldsChanged()
    // BroadcastChannel delivers on a later task.
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(SIE_HOLD_POLL_MS)
    expect(load).toHaveBeenCalledTimes(3)

    answer = []
    await vi.advanceTimersByTimeAsync(SIE_HOLD_POLL_MS)
    expect(load).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(load).toHaveBeenCalledTimes(4)
    unsubscribe()
    poller.stop()
  })
})

describe('announceSIEHoldsChanged', () => {
  it('reaches every subscriber, and nothing after unsubscribe', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = onSIEHoldsChanged(first)
    const stopSecond = onSIEHoldsChanged(second)
    announceSIEHoldsChanged()
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
    })
    stopFirst()
    announceSIEHoldsChanged()
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(2))
    expect(first).toHaveBeenCalledTimes(1)
    stopSecond()
  })
})

describe('fetchSIEHolds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the periods the route answers', async () => {
    const data = [period({ import_hold: 'import-1' })]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchSIEHolds(new AbortController().signal)).resolves.toEqual(data)
    expect(fetchMock).toHaveBeenCalledWith('/api/import/sie/holds', expect.objectContaining({ cache: 'no-store' }))
  })

  it('throws on an error status so the banner keeps its last answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await expect(fetchSIEHolds(new AbortController().signal)).rejects.toThrow('500')
  })
})
