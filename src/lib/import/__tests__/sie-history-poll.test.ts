import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSIEHistoryPollGate,
  startSIEHistoryPolling,
  SIE_HISTORY_IDLE_MAX_MS,
  SIE_HISTORY_POLL_MS,
  type SIEHistoryPollRow,
} from '@/lib/import/sie-history-poll'

const row = (overrides: Partial<SIEHistoryPollRow> = {}): SIEHistoryPollRow => ({
  id: 'import-1',
  status: 'completed',
  job_state: 'completed',
  transactions_count: 214,
  repair_outcome: null,
  ...overrides,
})

/** The history component's loop, with the page answers under the test's control. */
function run(initial: SIEHistoryPollRow[]) {
  let page = initial
  let visible = true
  const gate = createSIEHistoryPollGate()
  const fetchPage = vi.fn(async () => {
    gate.record(page, Date.now())
  })
  const controller = new AbortController()
  startSIEHistoryPolling({ gate, fetchPage, isVisible: () => visible, signal: controller.signal })
  return {
    gate,
    fetchPage,
    stop: () => controller.abort(),
    setPage: (rows: SIEHistoryPollRow[]) => { page = rows },
    setVisible: (value: boolean) => { visible = value },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T08:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SIE history poll', () => {
  it('fetches at once and follows a moving job every 5 s, as before', async () => {
    const loop = run([row({ job_state: 'running', status: 'pending' })])
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.fetchPage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(loop.fetchPage).toHaveBeenCalledTimes(13)
    loop.stop()
  })

  it('backs off on an unchanged idle page: 5, 10, 20, 40, then every 60 s', async () => {
    const loop = run([row()])
    await vi.advanceTimersByTimeAsync(0)
    const fetchedAt: number[] = []
    loop.fetchPage.mockImplementation(async () => {
      fetchedAt.push(Date.now())
      loop.gate.record([row()], Date.now())
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const start = new Date('2026-10-27T08:00:00Z').getTime()
    expect(fetchedAt.slice(0, 6).map((at) => (at - start) / 1000)).toEqual([5, 15, 35, 75, 135, 195])
    // Ten minutes: 13 fetches, where the old loop made 121.
    expect(loop.fetchPage).toHaveBeenCalledTimes(13)
    loop.stop()
  })

  it('goes back to 5 s as soon as the page changes, and stays there while a job moves', async () => {
    const loop = run([row()])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const fetchedAt: number[] = []
    let page = [row({ id: 'import-2', status: 'pending', job_state: 'queued' }), row()]
    loop.fetchPage.mockImplementation(async () => {
      fetchedAt.push(Date.now())
      loop.gate.record(page, Date.now())
    })

    // The change is seen on the next due fetch, at most a minute away.
    await vi.advanceTimersByTimeAsync(SIE_HISTORY_IDLE_MAX_MS)
    expect(fetchedAt.length).toBeGreaterThan(1)
    const gaps = fetchedAt.slice(1).map((at, i) => at - fetchedAt[i])
    expect(new Set(gaps)).toEqual(new Set([SIE_HISTORY_POLL_MS]))

    // The job finished: one changed page at 5 s, then the back-off again.
    page = [row({ id: 'import-2' }), row()]
    fetchedAt.length = 0
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const idleGaps = fetchedAt.slice(1).map((at, i) => (at - fetchedAt[i]) / 1000)
    expect(idleGaps.slice(0, 4)).toEqual([5, 10, 20, 40])
    loop.stop()
  })

  it('treats a paused job as waiting for a person, not as moving', async () => {
    const loop = run([row({ job_state: 'paused', status: 'pending' })])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(loop.fetchPage).toHaveBeenCalledTimes(13)
    loop.stop()
  })

  it('resets the pace when a fetch outside the loop (an undo) sees the change', async () => {
    const loop = run([row()])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const before = loop.fetchPage.mock.calls.length

    loop.gate.record([row({ job_state: 'undoing' })], Date.now())
    loop.setPage([row({ job_state: 'undoing' })])
    await vi.advanceTimersByTimeAsync(SIE_HISTORY_POLL_MS)
    expect(loop.fetchPage.mock.calls.length).toBe(before + 1)
    loop.stop()
  })

  it('does not fetch while the tab is hidden and catches up within 5 s of its return', async () => {
    const loop = run([row({ job_state: 'running', status: 'pending' })])
    await vi.advanceTimersByTimeAsync(0)
    loop.setVisible(false)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(loop.fetchPage).toHaveBeenCalledTimes(1)
    loop.setVisible(true)
    await vi.advanceTimersByTimeAsync(SIE_HISTORY_POLL_MS)
    expect(loop.fetchPage).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it('retries on the next tick after a failed fetch (nothing recorded)', async () => {
    const loop = run([row()])
    await vi.advanceTimersByTimeAsync(0)
    loop.fetchPage.mockImplementation(async () => {})
    await vi.advanceTimersByTimeAsync(SIE_HISTORY_POLL_MS * 3)
    expect(loop.fetchPage).toHaveBeenCalledTimes(4)
    loop.stop()
  })

  it('stops when aborted', async () => {
    const loop = run([row({ job_state: 'running', status: 'pending' })])
    await vi.advanceTimersByTimeAsync(0)
    loop.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(loop.fetchPage).toHaveBeenCalledTimes(1)
  })
})
