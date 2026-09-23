import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ __client: true })),
}))

// `after` is a no-op outside a request scope in these tests; the module falls
// back to a floating promise, which is the path a plain node server takes too.
vi.mock('next/server', () => ({
  after: () => {
    throw new Error('after() called outside a request scope')
  },
}))

import { kickWebhookDispatch, resetKickStateForTests, KICK_BATCH_SIZE } from '../dispatch-kick'

/**
 * A zero DispatchSummary. Spread rather than repeated so adding a counter to
 * the summary does not mean re-editing every case in this file; these tests
 * are about scheduling and coalescing, never about the counts.
 */
const EMPTY_SUMMARY = {
  picked: 0,
  delivered: 0,
  failed: 0,
  dead: 0,
  skipped: 0,
  released: 0,
  recovered: 0,
  recoveredDead: 0,
}

/** Resolves after the microtask queue drains, so floating work has run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  resetKickStateForTests()
})

describe('kickWebhookDispatch', () => {
  it('runs one dispatch cycle with the small kick batch size', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ...EMPTY_SUMMARY, picked: 1, delivered: 1 })

    kickWebhookDispatch(dispatch)
    await flush()

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({ batchSize: KICK_BATCH_SIZE })
  })

  it('claims far fewer rows than the cron, so a backlog cannot own a request tail', () => {
    // Each delivery can burn the full 10 s receiver timeout; the cron's 50 is
    // fine on a dedicated invocation, not on the tail of a user request.
    expect(KICK_BATCH_SIZE).toBeLessThan(50)
  })

  it('returns synchronously: the emitter never waits on receiver HTTP', async () => {
    let settled = false
    const dispatch = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true
            resolve({ ...EMPTY_SUMMARY })
          }, 20)
        }),
    )

    const returned = kickWebhookDispatch(dispatch as never)

    // eventBus.emit awaits its subscribers, so a kick that blocked here would
    // put a stranger's slow endpoint on the critical path of committing a
    // verifikat.
    expect(returned).toBeUndefined()
    expect(settled).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(settled).toBe(true)
  })

  it('coalesces a burst of kicks into a single cycle', async () => {
    // A bulk booking emits once per row. Without coalescing, 100 rows would
    // mean 100 claim round trips against the same handful of due deliveries.
    const dispatch = vi.fn().mockResolvedValue({ ...EMPTY_SUMMARY })

    for (let i = 0; i < 100; i++) kickWebhookDispatch(dispatch)
    await flush()

    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('accepts a new kick once the previous cycle has started', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ...EMPTY_SUMMARY })

    kickWebhookDispatch(dispatch)
    await flush()
    kickWebhookDispatch(dispatch)
    await flush()

    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('swallows a dispatch failure: a failed kick is latency, not a lost delivery', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('receiver unreachable'))

    expect(() => kickWebhookDispatch(dispatch)).not.toThrow()
    await flush()

    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not wedge the coalescing flag when a cycle fails', async () => {
    // The cron still covers every row, but a stuck flag would silently
    // disable the fast path for the life of the function instance.
    const failing = vi.fn().mockRejectedValue(new Error('boom'))
    kickWebhookDispatch(failing)
    await flush()

    const ok = vi.fn().mockResolvedValue({ ...EMPTY_SUMMARY })
    kickWebhookDispatch(ok)
    await flush()

    expect(ok).toHaveBeenCalledTimes(1)
  })
})
