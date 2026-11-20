/**
 * The request trace at the withRouteContext and withCronContext doors
 * (lib/observability/trace-context.ts): the handler runs in the trace of a
 * valid traceparent header, or a new one, and the response names it in
 * X-Trace-Id, refusals included. The request id is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockSupabase } from '@/tests/helpers'

const authState = vi.hoisted(() => ({ user: { id: 'user-1' } as { id: string } | null }))
const cronAuth = vi.hoisted(() => ({ refuse: false }))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (!authState.user) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
    return { user: authState.user, supabase: createMockSupabase().supabase }
  }),
}))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn(async () => 'company-1') }))
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => (cronAuth.refuse ? NextResponse.json({}, { status: 401 }) : null)),
}))

import { withRouteContext } from '../with-route-context'
import { withCronContext } from '../with-cron-context'
import { getTraceId } from '@/lib/observability/trace-context'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`
const EMPTY_PARAMS = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  authState.user = { id: 'user-1' }
  cronAuth.refuse = false
})

describe('withRouteContext trace', () => {
  it('runs the handler in the trace of a valid traceparent header and names it in X-Trace-Id', async () => {
    let seen: string | undefined
    const route = withRouteContext('test.trace', async () => {
      await Promise.resolve()
      seen = getTraceId()
      return NextResponse.json({ ok: true })
    })

    const res = await route(new Request('http://localhost/api/test', { headers: { traceparent: TRACEPARENT } }), EMPTY_PARAMS)

    expect(seen).toBe(TRACE_ID)
    expect(res.headers.get('X-Trace-Id')).toBe(TRACE_ID)
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    expect(getTraceId()).toBeUndefined()
  })

  it('mints a trace when the header is missing or invalid', async () => {
    const seen: Array<string | undefined> = []
    const route = withRouteContext('test.trace', async () => {
      seen.push(getTraceId())
      return NextResponse.json({ ok: true })
    })

    const missing = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)
    const invalid = await route(
      new Request('http://localhost/api/test', { headers: { traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` } }),
      EMPTY_PARAMS,
    )

    expect(seen[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(seen[1]).toMatch(/^[0-9a-f]{32}$/)
    expect(seen[0]).not.toBe(seen[1])
    expect(missing.headers.get('X-Trace-Id')).toBe(seen[0])
    expect(invalid.headers.get('X-Trace-Id')).toBe(seen[1])
  })

  it('names the trace on a refusal before the handler', async () => {
    authState.user = null
    const handler = vi.fn()
    const route = withRouteContext('test.trace', handler)

    const res = await route(new Request('http://localhost/api/test', { headers: { traceparent: TRACEPARENT } }), EMPTY_PARAMS)

    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    expect(res.headers.get('X-Trace-Id')).toBe(TRACE_ID)
  })
})

describe('withCronContext trace', () => {
  it('runs the job in a new trace and names it in X-Trace-Id', async () => {
    let seen: string | undefined
    const res = await withCronContext('cron.test', async () => {
      seen = getTraceId()
      return NextResponse.json({ ok: true })
    })(new Request('https://example.test/api/x/cron'))

    expect(seen).toMatch(/^[0-9a-f]{32}$/)
    expect(res.headers.get('X-Trace-Id')).toBe(seen)
    expect(res.headers.get('X-Request-Id')).toMatch(/^cron_/)
    expect(getTraceId()).toBeUndefined()
  })

  it('takes the trace of a valid traceparent header, and names it on a refused secret too', async () => {
    let seen: string | undefined
    const job = withCronContext('cron.test', async () => {
      seen = getTraceId()
      return NextResponse.json({ ok: true })
    })
    const res = await job(new Request('https://example.test/api/x/cron', { headers: { traceparent: TRACEPARENT } }))
    expect(seen).toBe(TRACE_ID)
    expect(res.headers.get('X-Trace-Id')).toBe(TRACE_ID)

    cronAuth.refuse = true
    const refused = await job(new Request('https://example.test/api/x/cron', { headers: { traceparent: TRACEPARENT } }))
    expect(refused.status).toBe(401)
    expect(refused.headers.get('X-Trace-Id')).toBe(TRACE_ID)
  })
})
