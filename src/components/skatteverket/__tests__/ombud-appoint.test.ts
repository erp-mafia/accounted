import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OMBUD_VERIFY_MAX_AUTO_RETRIES } from '@/lib/skatteverket/ombud-verify-retry'
import { verifyOmbudGrantWithRetries } from '../ombud-appoint'

const fetchMock = vi.fn(async (..._a: unknown[]) => new Response())

function refused(seconds?: number): Response {
  return new Response(JSON.stringify({ error: 'Vänta en minut mellan verifieringar.', ...(seconds ? { retry_after_seconds: seconds } : {}) }), {
    status: 429,
    headers: seconds ? { 'Retry-After': String(seconds) } : {},
  })
}

function granted(): Response {
  return new Response(JSON.stringify({ data: { connection: { status: 'active', lasombud_status: 'granted', moms_ombud_status: 'granted' } } }), { status: 200 })
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('verifyOmbudGrantWithRetries', () => {
  it('a check that is not paced answers at once, with no wait', async () => {
    fetchMock.mockResolvedValueOnce(granted())
    const onWaiting = vi.fn()
    const outcome = await verifyOmbudGrantWithRetries('sv', new AbortController().signal, onWaiting)
    expect(outcome?.result).toBe('granted')
    expect(onWaiting).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a paced check says it waits, asks again only after the wait the server named, and reports the answer', async () => {
    fetchMock.mockResolvedValueOnce(refused(40)).mockResolvedValueOnce(granted())
    const onWaiting = vi.fn()
    const done = verifyOmbudGrantWithRetries('sv', new AbortController().signal, onWaiting)
    await vi.advanceTimersByTimeAsync(0)
    expect(onWaiting).toHaveBeenCalledWith(41)
    // Not a moment sooner than the server said.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await done)?.result).toBe('granted')
  })

  it('is bounded: after the automatic retries the refusal goes back to the person', async () => {
    fetchMock.mockImplementation(async () => refused(5))
    const onWaiting = vi.fn()
    const done = verifyOmbudGrantWithRetries('sv', new AbortController().signal, onWaiting)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect((await done)?.result).toBe('rate_limited')
    expect(fetchMock).toHaveBeenCalledTimes(1 + OMBUD_VERIFY_MAX_AUTO_RETRIES)
    expect(onWaiting).toHaveBeenCalledTimes(OMBUD_VERIFY_MAX_AUTO_RETRIES)
  })

  it('waits the full minute when the refusal names no wait', async () => {
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(granted())
    const done = verifyOmbudGrantWithRetries('sv', new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await done)?.result).toBe('granted')
  })

  it('an abort during the wait ends it with nothing to report and no further request', async () => {
    fetchMock.mockResolvedValueOnce(refused(40))
    const run = new AbortController()
    const done = verifyOmbudGrantWithRetries('sv', run.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(10_000)
    run.abort()
    expect(await done).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
