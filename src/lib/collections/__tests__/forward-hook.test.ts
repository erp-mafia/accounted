/**
 * scheduleCollectionForwardDrain: one drain per company until it starts,
 * however many payment rows a request writes; a new one once it has started
 * or when the scheduled one never ran; nothing outside a request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callbacks: Array<() => Promise<void>> = []
let inRequest = true
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    if (!inRequest) throw new Error('after() was called outside a request scope')
    callbacks.push(fn)
  },
}))
const drain = vi.fn(async () => ({ claimed: 0 }))
vi.mock('../forwarding', () => ({ drainCollectionForwards: (...args: unknown[]) => drain(...(args as [])) }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))

import { FORWARD_DRAIN_SCHEDULE_STALE_MS, scheduleCollectionForwardDrain } from '../forward-hook'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function runScheduled(): Promise<void> {
  const pending = callbacks.splice(0)
  for (const fn of pending) await fn()
}

beforeEach(async () => {
  vi.clearAllMocks()
  inRequest = true
  // Start from no scheduled drain: run whatever an earlier test left.
  await runScheduled()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduleCollectionForwardDrain', () => {
  it('schedules one drain per company for a request that writes many payment rows', async () => {
    for (let i = 0; i < 5; i++) scheduleCollectionForwardDrain(A)
    scheduleCollectionForwardDrain(B)
    expect(callbacks).toHaveLength(2)
    await runScheduled()
    expect(drain).toHaveBeenCalledTimes(2)
    expect(drain.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ companyId: A }, { companyId: B }])
  })

  it('schedules again once the drain has started, so a later row is never left to the cron', async () => {
    scheduleCollectionForwardDrain(A)
    await runScheduled()
    scheduleCollectionForwardDrain(A)
    expect(callbacks).toHaveLength(1)
  })

  it('schedules again when the earlier drain never started', () => {
    vi.useFakeTimers()
    scheduleCollectionForwardDrain(A)
    vi.advanceTimersByTime(FORWARD_DRAIN_SCHEDULE_STALE_MS + 1)
    scheduleCollectionForwardDrain(A)
    expect(callbacks).toHaveLength(2)
  })

  it('does nothing outside a request or without a company, and remembers nothing then', () => {
    inRequest = false
    scheduleCollectionForwardDrain(A)
    scheduleCollectionForwardDrain(null)
    expect(callbacks).toHaveLength(0)
    inRequest = true
    scheduleCollectionForwardDrain(A)
    expect(callbacks).toHaveLength(1)
  })
})
