import { describe, expect, it, vi } from 'vitest'
import { reloadUntilReported } from '../case-reload'
import { caseForwardState } from '../forwarding'

const data = (forwardsInFlight: boolean, total: number) => ({ case: { forwardsInFlight, outstandingTotal: total } })

describe('reloadUntilReported', () => {
  it('reads again while a report is on its way, then stops with the new amounts', async () => {
    const reads = [data(true, 1250), data(true, 1250), data(false, 750)]
    const read = vi.fn(async () => reads.shift() ?? null)
    const applied: number[] = []
    const sleep = vi.fn(async () => {})
    await reloadUntilReported(read, (next) => applied.push(next.case.outstandingTotal), { sleep, delayMs: 10 })
    expect(read).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(applied).toEqual([1250, 1250, 750])
  })

  it('reads once when nothing is on its way, and gives up after the tries', async () => {
    const once = vi.fn(async () => data(false, 750))
    await reloadUntilReported(once, () => {}, { sleep: async () => {} })
    expect(once).toHaveBeenCalledTimes(1)

    const stuck = vi.fn(async () => data(true, 1250))
    await reloadUntilReported(stuck, () => {}, { sleep: async () => {}, tries: 3 })
    expect(stuck).toHaveBeenCalledTimes(3)
  })

  it('stops when the case cannot be read', async () => {
    const failing = vi.fn(async () => null)
    const apply = vi.fn()
    await reloadUntilReported(failing, apply, { sleep: async () => {} })
    expect(failing).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('caseForwardState', () => {
  const now = new Date('2026-10-06T08:01:00Z')
  const row = (overrides: Partial<{ status: string; next_attempt_at: string | null; forwarded_at: string | null; reverted_at: string | null }>) => ({
    status: 'pending',
    next_attempt_at: null,
    forwarded_at: null,
    reverted_at: null,
    ...overrides,
  })

  it('counts a report or revert due now as in flight, not one waiting for its retry', () => {
    expect(caseForwardState([row({})], null, now).inFlight).toBe(true)
    expect(caseForwardState([row({ status: 'revert_pending', forwarded_at: '2026-10-06T07:00:00Z' })], null, now).inFlight).toBe(true)
    expect(caseForwardState([row({ next_attempt_at: '2026-10-06T08:05:00Z' })], null, now).inFlight).toBe(false)
    expect(caseForwardState([row({ status: 'failed' })], null, now).inFlight).toBe(false)
  })

  it('knows when a report reached the provider after the snapshot', () => {
    const snapshot = '2026-10-06T08:00:00Z'
    expect(caseForwardState([row({ status: 'forwarded', forwarded_at: '2026-10-06T08:00:30Z' })], snapshot, now).reportedSince).toBe(true)
    expect(caseForwardState([row({ status: 'forwarded', forwarded_at: '2026-10-06T07:59:00Z' })], snapshot, now).reportedSince).toBe(false)
    expect(caseForwardState([row({ status: 'reverted', reverted_at: '2026-10-06T08:00:10Z' })], snapshot, now).reportedSince).toBe(true)
    expect(caseForwardState([row({ status: 'forwarded', forwarded_at: '2026-10-06T07:00:00Z' })], null, now).reportedSince).toBe(true)
  })
})
