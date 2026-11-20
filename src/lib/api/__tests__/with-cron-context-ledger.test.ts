import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const { verifyCronSecret } = vi.hoisted(() => ({ verifyCronSecret: vi.fn((): unknown => null) }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret }))
const { registryGet } = vi.hoisted(() => ({ registryGet: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: registryGet } }))
const { startCronRun, finishCronRun } = vi.hoisted(() => ({ startCronRun: vi.fn(), finishCronRun: vi.fn() }))
vi.mock('@/lib/cron/run-ledger', () => ({ startCronRun, finishCronRun, MAX_SUMMARY_BYTES: 4_000, LEDGER_CLOSE_BUDGET_MS: 4_000 }))
const { flushObservability } = vi.hoisted(() => ({ flushObservability: vi.fn() }))
vi.mock('@/lib/observability/sink', async (original) => ({ ...(await original<typeof import('@/lib/observability/sink')>()), flushObservability }))
const { logged } = vi.hoisted(() => {
  const logged = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  logged.child.mockReturnValue(logged)
  return { logged }
})
vi.mock('@/lib/logger', () => ({ createLogger: () => logged }))

import { withCronContext } from '../with-cron-context'

const PAYMENTS = '/api/payments/orders/status/cron'
const request = (path = PAYMENTS) => new Request(`https://app.example.test${path}`)
let order: string[]

beforeEach(() => {
  vi.clearAllMocks()
  order = []
  verifyCronSecret.mockReturnValue(null)
  registryGet.mockResolvedValue({ id: 'shopify' })
  startCronRun.mockImplementation(async () => (order.push('start'), 'run-1'))
  finishCronRun.mockImplementation(async () => void order.push('finish'))
  logged.child.mockReturnValue(logged)
  flushObservability.mockImplementation(async () => (order.push('flush'), true))
})

describe('withCronContext: the run ledger', () => {
  it('gives the close and the flush only the time the route has left: a job that finished its work in time is not killed by its bookkeeping', async () => {
    // events/dispatch declares maxDuration 60. The handler answers 57.5 s into the run.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await withCronContext('cron.event_outbox_dispatch', async () => {
        vi.setSystemTime(Date.now() + 57_500)
        return NextResponse.json({ ok: true })
      })(request('/api/events/dispatch/cron'))

      // 60 s less the 2 s kept for the answer leaves 0.5 s: the close still gets
      // its floor of a second (an unclosed row reads as a killed run), the flush
      // only what is left.
      expect(finishCronRun.mock.calls[0]![3]).toBe(1_000)
      expect(flushObservability).toHaveBeenCalledWith(500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a quick run the full close wait and the full flush', async () => {
    await withCronContext('cron.payment_order_status', async () => NextResponse.json({ ok: true }))(request())

    expect(finishCronRun.mock.calls[0]![3]).toBe(4_000)
    expect(flushObservability).toHaveBeenCalledWith(2_000)
  })

  it('opens the run before the handler with the path, the operation and the limit the route declares, and closes it as ok with what the job answered', async () => {
    const handler = vi.fn(async () => (order.push('handler'), NextResponse.json({ data: { checked: 23, deferred: 0 } })))

    const res = await withCronContext('cron.payment_order_status', handler)(request())

    expect(res.status).toBe(200)
    expect(order).toEqual(['start', 'handler', 'finish', 'flush'])
    expect(startCronRun).toHaveBeenCalledWith({ path: PAYMENTS, operation: 'cron.payment_order_status', limitMs: 300_000, requestId: expect.stringMatching(/^cron_/) })
    expect(finishCronRun).toHaveBeenCalledWith('run-1', { status: 'ok', httpStatus: 200, durationMs: expect.any(Number), summary: { checked: 23, deferred: 0 } }, undefined, expect.any(Number))
    // The answer is still the handler's to read.
    await expect(res.json()).resolves.toEqual({ data: { checked: 23, deferred: 0 } })
  })

  it('records a path that vercel.json does not schedule without a limit', async () => {
    await withCronContext('cron.connector_sync', async () => NextResponse.json({ ok: true }))(request('/api/connector/sync/cron'))

    expect(startCronRun).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/connector/sync/cron', limitMs: null }))
    expect(finishCronRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'ok', summary: { ok: true } }), undefined, expect.any(Number))
  })

  it('closes the run as failed when the handler throws, with the error, and still answers', async () => {
    const res = await withCronContext('cron.test', async () => {
      throw new TypeError('rows is not iterable')
    })(request())

    expect(res.status).toBe(500)
    expect(finishCronRun).toHaveBeenCalledWith('run-1', { status: 'failed', httpStatus: 500, durationMs: expect.any(Number), error: 'TypeError: rows is not iterable' }, undefined, expect.any(Number))
    expect(order).toEqual(['start', 'finish', 'flush'])
  })

  it('counts an answer of 400 or above as failed even when the handler returned it', async () => {
    // import/sie/invariants answered 503 on all four of its runs to 2026-11-09 and nothing reported it.
    const res = await withCronContext('cron.test', async () => NextResponse.json({ error: 'violated' }, { status: 503 }))(request())

    expect(res.status).toBe(503)
    expect(finishCronRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'failed', httpStatus: 503, summary: { error: 'violated' } }), undefined, expect.any(Number))
    // And says so where the error tracker hears it: before, this was one info line.
    expect(logged.error).toHaveBeenCalledWith('cron run answered an error status', expect.objectContaining({ status: 503, alert: true }))
  })

  it('reports nothing to the error tracker for a run that answered below 400', async () => {
    await withCronContext('cron.test', async () => NextResponse.json({ ok: true }))(request())

    expect(logged.error).not.toHaveBeenCalled()
  })

  it('records a skipped extension as a run: the schedule called the job and the job answered', async () => {
    registryGet.mockResolvedValue(undefined)
    const handler = vi.fn()

    const res = await withCronContext('cron.test', handler, { requireExtension: 'shopify' })(request())

    expect(res.status).toBe(200)
    expect(handler).not.toHaveBeenCalled()
    expect(finishCronRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'ok', httpStatus: 200, summary: { skipped: true, reason: 'extension_disabled' } }), undefined, expect.any(Number))
  })

  it('records nothing for a caller without the cron secret', async () => {
    verifyCronSecret.mockReturnValue({ error: 'unauthorized' })

    const res = await withCronContext('cron.test', vi.fn())(request())

    expect(res.status).toBe(401)
    expect(startCronRun).not.toHaveBeenCalled()
    expect(finishCronRun).not.toHaveBeenCalled()
  })

  it('runs the job all the same when the ledger gave no row, and reads no body for a summary nobody keeps', async () => {
    startCronRun.mockResolvedValue(null)
    const response = NextResponse.json({ data: { ok: true } })
    const clone = vi.spyOn(response, 'clone')

    const res = await withCronContext('cron.test', async () => response)(request())

    expect(res.status).toBe(200)
    expect(clone).not.toHaveBeenCalled()
    expect(finishCronRun).toHaveBeenCalledWith(null, expect.objectContaining({ status: 'ok', summary: undefined }), undefined, expect.any(Number))
  })

  it('keeps no summary of an answer that is not JSON or is too large', async () => {
    await withCronContext('cron.test', async () => new Response('done'))(request())
    expect(finishCronRun).toHaveBeenLastCalledWith('run-1', expect.objectContaining({ summary: undefined }), undefined, expect.any(Number))

    await withCronContext('cron.test', async () => NextResponse.json({ data: { rows: 'x'.repeat(5_000) } }))(request())
    expect(finishCronRun).toHaveBeenLastCalledWith('run-1', expect.objectContaining({ status: 'ok', summary: undefined }), undefined, expect.any(Number))
  })
})
