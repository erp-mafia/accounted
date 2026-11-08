import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { isPermanentPollFailure, startPollLoop } from '../poll-loop'

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
      .mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
      .mockImplementation((signal: AbortSignal) => {
        signalSeen = signal
        return new Promise(() => {})
      })
    const onResult = vi.fn().mockReturnValue(true)
    const onGiveUp = vi.fn()
    const stop = startPollLoop({ poll, onResult, onGiveUp, intervalMs: 500, immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(onGiveUp).not.toHaveBeenCalled()
    stop()
    expect(signalSeen!.aborted).toBe(true)
  })

  // crm#1355: a connection that is gone answers 404 on every poll; asking
  // again cannot change that, so the loop ends at once and says why.
  it('ends at once on a refusal no retry changes (a 404) and reports it', async () => {
    const gone = Object.assign(new Error('open payments request failed (404)'), { status: 404 })
    const poll = vi.fn().mockRejectedValue(gone)
    const onGiveUp = vi.fn()
    startPollLoop({ poll, onResult: () => true, onGiveUp, intervalMs: 100, immediate: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledWith(gone, 'refused')
  })

  // The bank feed's own answers: a refusal is the bank's answer on every try
  // (a missing user right was polled 10 times, then shown as no answer), while
  // a bank that does not answer is asked again.
  it('ends at once on the bank feed\'s refusal and keeps asking while the bank is unavailable', async () => {
    const refused = { status: getErrorEntry('BANK_PROVIDER_REFUSED')?.httpStatus }
    const poll = vi.fn().mockRejectedValue(refused)
    const onGiveUp = vi.fn()
    startPollLoop({ poll, onResult: () => true, onGiveUp, intervalMs: 100, immediate: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledWith(refused, 'refused')
    expect(isPermanentPollFailure({ status: getErrorEntry('BANK_PROVIDER_UNAVAILABLE')?.httpStatus })).toBe(false)
  })

  it('ends on a refusal even without a give-up handler', async () => {
    const poll = vi.fn().mockRejectedValue({ status: 409 })
    startPollLoop({ poll, onResult: () => true, intervalMs: 100, immediate: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx, a 408, a 429 and the network, and gives up after maxFailures in a row', async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 408 })
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValue(new TypeError('Failed to fetch'))
    const onGiveUp = vi.fn()
    startPollLoop({ poll, onResult: () => true, onGiveUp, intervalMs: 100, immediate: true, maxFailures: 5 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(poll).toHaveBeenCalledTimes(5)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp.mock.calls[0][1]).toBe('unreachable')
  })

  it('an answer in between resets the failure count', async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce({ status: 502 })
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValueOnce('pending')
      .mockRejectedValueOnce({ status: 502 })
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValue('pending')
    const onGiveUp = vi.fn()
    const stop = startPollLoop({ poll, onResult: () => true, onGiveUp, intervalMs: 100, immediate: true, maxFailures: 3 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onGiveUp).not.toHaveBeenCalled()
    expect(poll.mock.calls.length).toBeGreaterThan(6)
    stop()
  })

  it('never reports a give-up for a poll that failed because the loop was stopped', async () => {
    let reject: (error: unknown) => void = () => {}
    const poll = vi.fn().mockImplementation(() => new Promise((_, r) => { reject = r }))
    const onGiveUp = vi.fn()
    const stop = startPollLoop({ poll, onResult: () => true, onGiveUp, intervalMs: 100, immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    stop()
    reject({ status: 404 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onGiveUp).not.toHaveBeenCalled()
  })
})

describe('isPermanentPollFailure', () => {
  it('is a 4xx other than 408 and 429', () => {
    expect(isPermanentPollFailure({ status: 400 })).toBe(true)
    expect(isPermanentPollFailure({ status: 401 })).toBe(true)
    expect(isPermanentPollFailure({ status: 404 })).toBe(true)
    expect(isPermanentPollFailure({ status: 409 })).toBe(true)
    expect(isPermanentPollFailure({ status: 408 })).toBe(false)
    expect(isPermanentPollFailure({ status: 429 })).toBe(false)
    expect(isPermanentPollFailure({ status: 500 })).toBe(false)
    expect(isPermanentPollFailure(new TypeError('Failed to fetch'))).toBe(false)
    expect(isPermanentPollFailure(null)).toBe(false)
    expect(isPermanentPollFailure('404')).toBe(false)
  })
})
