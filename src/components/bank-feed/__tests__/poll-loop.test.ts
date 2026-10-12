import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPollLoop } from '../poll-loop'

describe('startPollLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls one request at a time, scheduling the next only after the previous answered', async () => {
    const poll = vi.fn().mockResolvedValue('pending')
    const onResult = vi.fn().mockReturnValue(true)
    const stop = startPollLoop({ poll, onResult, intervalMs: 1000 })

    expect(poll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('stops when the result says so and never calls back after stop', async () => {
    const poll = vi.fn().mockResolvedValue('valid')
    const onResult = vi.fn().mockReturnValue(false)
    startPollLoop({ poll, onResult, intervalMs: 1000, immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed poll and aborts the request in flight on stop', async () => {
    let signalSeen: AbortSignal | null = null
    const poll = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('network')))
      .mockImplementation((signal: AbortSignal) => {
        signalSeen = signal
        return new Promise(() => {})
      })
    const onResult = vi.fn().mockReturnValue(true)
    const onError = vi.fn().mockReturnValue(true)
    const stop = startPollLoop({ poll, onResult, onError, intervalMs: 500, immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(poll).toHaveBeenCalledTimes(2)
    stop()
    expect(signalSeen!.aborted).toBe(true)
  })

  it('an error handler that returns false ends the loop', async () => {
    const poll = vi.fn().mockRejectedValue(new Error('403'))
    const onError = vi.fn().mockReturnValue(false)
    startPollLoop({ poll, onResult: () => true, onError, intervalMs: 100, immediate: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(poll).toHaveBeenCalledTimes(1)
  })
})
