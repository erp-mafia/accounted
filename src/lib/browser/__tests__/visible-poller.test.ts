import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVisiblePoller, type VisiblePollerOptions } from '@/lib/browser/visible-poller'

type Result = { busy: boolean }

function setup(overrides: Partial<VisiblePollerOptions<Result>> = {}) {
  let visible = true
  let next: Result | Error = { busy: false }
  const load = vi.fn(async () => {
    if (next instanceof Error) throw next
    return next
  })
  const onResult = vi.fn()
  const poller = createVisiblePoller<Result>({
    load,
    onResult,
    intervalMs: (last) => (last?.busy ? 5_000 : null),
    staleAfterMs: (last) => (last?.busy ? 5_000 : 300_000),
    retryMs: 60_000,
    isVisible: () => visible,
    ...overrides,
  })
  return {
    poller,
    load,
    onResult,
    setVisible: (value: boolean) => { visible = value },
    answer: (value: Result | Error) => { next = value },
  }
}

/** Let the awaited load and the scheduling after it run. */
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T08:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createVisiblePoller', () => {
  it('fetches once on refresh and sets no timer while idle', async () => {
    const { poller, load, onResult } = setup()
    poller.refresh()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({ busy: false })

    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(load).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('follows a busy result on its interval and stops when it clears', async () => {
    const { poller, load, answer } = setup()
    answer({ busy: true })
    poller.refresh()
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(3)

    answer({ busy: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(load).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('lets a nudge fetch only once the last answer is stale', async () => {
    const { poller, load } = setup()
    poller.refresh()
    await settle()

    // Navigation and focus within five minutes cost nothing.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(20_000)
      poller.nudge()
      await settle()
    }
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100_000)
    poller.nudge()
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('does not fetch or keep a timer while the tab is hidden, and resumes on return', async () => {
    const { poller, load, answer, setVisible } = setup()
    answer({ busy: true })
    poller.refresh()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)

    setVisible(false)
    poller.nudge()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(1)
    poller.refresh()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)

    setVisible(true)
    poller.nudge()
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('resumes a stopped timer from where it was when the answer is still fresh', async () => {
    const { poller, load, setVisible } = setup({
      intervalMs: () => 30 * 60_000,
      staleAfterMs: () => 5 * 60_000,
    })
    poller.refresh()
    await settle()
    setVisible(false)
    poller.nudge()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    setVisible(true)
    poller.nudge()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(28 * 60_000 - 1)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('runs once more when a refresh arrives while a fetch is in flight', async () => {
    let release: (value: Result) => void = () => {}
    const load = vi.fn(() => new Promise<Result>((resolve) => { release = resolve }))
    const { poller } = setup({ load })
    poller.refresh()
    poller.refresh()
    poller.nudge()
    expect(load).toHaveBeenCalledTimes(1)
    release({ busy: false })
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    release({ busy: false })
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('keeps the last result on a failure and retries after retryMs', async () => {
    const { poller, load, onResult, answer } = setup()
    poller.refresh()
    await settle()
    answer(new Error('offline'))
    await vi.advanceTimersByTimeAsync(300_000)
    poller.nudge()
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledTimes(1)

    answer({ busy: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(onResult).toHaveBeenLastCalledWith({ busy: true })
    poller.stop()
  })

  it('stops fetching after stop()', async () => {
    const { poller, load, answer } = setup()
    answer({ busy: true })
    poller.refresh()
    await settle()
    poller.stop()
    poller.refresh()
    poller.nudge()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
