import { describe, expect, it } from 'vitest'
import { accepted, created, noContent, ok, paginated } from '../response'
import { API_V1_VERSION, API_V1_VERSION_HEADER } from '../version'

describe('v1 response helpers', () => {
  const requestId = 'req_abc'

  it('ok() wraps data with meta and stamps standard headers', async () => {
    const res = ok({ hello: 'world' }, { requestId })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Request-Id')).toBe(requestId)
    expect(res.headers.get(API_V1_VERSION_HEADER)).toBe(API_V1_VERSION)
    const body = await res.json()
    expect(body).toEqual({
      data: { hello: 'world' },
      meta: { request_id: requestId, api_version: API_V1_VERSION },
    })
  })

  it('paginated() includes next_cursor when provided', async () => {
    const res = paginated([{ id: 1 }], { requestId, nextCursor: 'cur_xyz' })
    const body = await res.json()
    expect(body.meta.next_cursor).toBe('cur_xyz')
    expect(body.data).toEqual([{ id: 1 }])
  })

  it('paginated() omits next_cursor when not provided', async () => {
    const res = paginated([], { requestId })
    const body = await res.json()
    expect(body.meta.next_cursor).toBeUndefined()
  })

  it('created() returns 201', () => {
    const res = created({}, { requestId })
    expect(res.status).toBe(201)
  })

  it('accepted() returns 202 with operation_id + poll_url', async () => {
    const res = accepted('op_123', 'import.sie', { requestId })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.data).toEqual({
      operation_id: 'op_123',
      type: 'import.sie',
      status: 'queued',
      poll_url: '/api/v1/operations/op_123',
      webhook_event: 'operation.completed',
    })
  })

  it('noContent() returns 204 with no body', async () => {
    const res = noContent({ requestId })
    expect(res.status).toBe(204)
    expect(res.headers.get('X-Request-Id')).toBe(requestId)
  })

  it('stamps Idempotent-Replayed when set', () => {
    const res = ok({}, { requestId, idempotentReplay: true })
    expect(res.headers.get('Idempotent-Replayed')).toBe('true')
  })

  it('stamps X-Dry-Run when set', () => {
    const res = ok({}, { requestId, dryRun: true })
    expect(res.headers.get('X-Dry-Run')).toBe('true')
  })

  it('stamps rate-limit headers when supplied', () => {
    const reset = new Date(1_700_000_000_000)
    const res = ok({}, { requestId, rateLimit: { limit: 100, remaining: 42, resetAt: reset } })
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('42')
    expect(res.headers.get('X-RateLimit-Reset')).toBe(String(Math.floor(reset.getTime() / 1000)))
  })

  it('includes audit block in meta for write responses', async () => {
    const res = ok({}, {
      requestId,
      audit: { voucher_number: 'A2026-0042', immutable_at: '2026-05-12T16:00:00Z' },
    })
    const body = await res.json()
    expect(body.meta.audit).toEqual({
      voucher_number: 'A2026-0042',
      immutable_at: '2026-05-12T16:00:00Z',
    })
  })
})
