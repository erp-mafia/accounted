import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import { AI_POLL_MS, AI_POLL_WINDOW_MS, createAiStatusPoller } from '../ai-status-poll'

/** A status read the test resolves by hand, so a slow response can be held open. */
function deferredFetch() {
  const pending: { resolve: (v: AiClient[] | null) => void; signal: AbortSignal }[] = []
  const fetchStatus = vi.fn(
    (signal: AbortSignal) => new Promise<AiClient[] | null>((resolve) => pending.push({ resolve, signal })),
  )
  return { fetchStatus, pending }
}

describe('createAiStatusPoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never overlaps a response that takes longer than the interval', async () => {
    const { fetchStatus, pending } = deferredFetch()
    const poller = createAiStatusPoller({ fetchStatus, onStatus: vi.fn() })
    poller.attempt('claude')
    await vi.advanceTimersByTimeAsync(AI_POLL_MS * 3)
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    pending[0].resolve([])
    await vi.advanceTimersByTimeAsync(AI_POLL_MS - 1)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('shares one outstanding request between a click and a focus', async () => {
    const { fetchStatus, pending } = deferredFetch()
    const poller = createAiStatusPoller({ fetchStatus, onStatus: vi.fn() })
    poller.attempt('claude')
    poller.check()
    poller.check()
    poller.attempt('chatgpt')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    pending[0].resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('keeps the last status and ends the window when a read fails', async () => {
    const onStatus = vi.fn()
    const fetchStatus = vi.fn<(signal: AbortSignal) => Promise<AiClient[] | null>>()
      .mockResolvedValueOnce(['grok'])
      .mockResolvedValueOnce(null)
    const poller = createAiStatusPoller({ fetchStatus, onStatus })
    poller.attempt('claude')
    await vi.advanceTimersByTimeAsync(AI_POLL_MS)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenLastCalledWith(['grok'])

    await vi.advanceTimersByTimeAsync(AI_POLL_WINDOW_MS)
    expect(fetchStatus).toHaveBeenCalledTimes(2)

    // Coming back reopens the window: the attempt is still unanswered.
    fetchStatus.mockResolvedValue([])
    poller.check()
    await vi.advanceTimersByTimeAsync(AI_POLL_MS)
    expect(fetchStatus).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('treats a thrown read like an unavailable status', async () => {
    const onStatus = vi.fn()
    const fetchStatus = vi.fn().mockRejectedValue(new Error('network'))
    const poller = createAiStatusPoller({ fetchStatus, onStatus })
    poller.attempt('claude')
    await vi.advanceTimersByTimeAsync(AI_POLL_MS * 2)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(onStatus).not.toHaveBeenCalled()
    poller.stop()
  })

  it('stops when the attempted client connects, and another attempt restarts it', async () => {
    const onStatus = vi.fn()
    const fetchStatus = vi.fn<(signal: AbortSignal) => Promise<AiClient[] | null>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue(['claude'])
    const poller = createAiStatusPoller({ fetchStatus, onStatus })
    poller.attempt('claude')
    await vi.advanceTimersByTimeAsync(AI_POLL_MS)
    expect(onStatus).toHaveBeenLastCalledWith(['claude'])
    await vi.advanceTimersByTimeAsync(AI_POLL_WINDOW_MS)
    expect(fetchStatus).toHaveBeenCalledTimes(2)

    poller.attempt('chatgpt')
    await vi.advanceTimersByTimeAsync(AI_POLL_MS)
    expect(fetchStatus).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('ends the window when the time runs out', async () => {
    const fetchStatus = vi.fn().mockResolvedValue([])
    const poller = createAiStatusPoller({ fetchStatus, onStatus: vi.fn() })
    poller.attempt('claude')
    await vi.advanceTimersByTimeAsync(AI_POLL_WINDOW_MS * 3)
    expect(fetchStatus).toHaveBeenCalledTimes(AI_POLL_WINDOW_MS / AI_POLL_MS + 1)
    poller.stop()
  })

  it('asks once on focus when no attempt is pending', async () => {
    const fetchStatus = vi.fn().mockResolvedValue([])
    const poller = createAiStatusPoller({ fetchStatus, onStatus: vi.fn() })
    poller.check()
    await vi.advanceTimersByTimeAsync(AI_POLL_WINDOW_MS)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('does not read while the tab is hidden, and resumes on focus', async () => {
    let hidden = false
    const fetchStatus = vi.fn().mockResolvedValue([])
    const poller = createAiStatusPoller({ fetchStatus, onStatus: vi.fn(), isHidden: () => hidden })
    poller.attempt('claude')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    hidden = true
    await vi.advanceTimersByTimeAsync(AI_POLL_MS * 5)
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    hidden = false
    poller.check()
    await vi.advanceTimersByTimeAsync(AI_POLL_MS)
    expect(fetchStatus).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('aborts the outstanding read on stop and ignores its answer', async () => {
    const onStatus = vi.fn()
    const { fetchStatus, pending } = deferredFetch()
    const poller = createAiStatusPoller({ fetchStatus, onStatus })
    poller.attempt('claude')
    poller.stop()
    expect(pending[0].signal.aborted).toBe(true)

    pending[0].resolve(['claude'])
    await vi.advanceTimersByTimeAsync(AI_POLL_WINDOW_MS)
    expect(onStatus).not.toHaveBeenCalled()
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    poller.check()
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })
})
