/**
 * Tests for the sandbox cleanup cron route: the run loops small RPC batches
 * (each PostgREST statement gets its own 8s window; a function-level
 * statement_timeout cannot lift it), stops when a batch makes no progress,
 * aggregates totals across batches, accepts the legacy bare-integer return
 * shape, and logs failures at error level: the failure mode this route
 * chain fixes was months of silently swallowed cleanup errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/api/with-cron-context', () => ({
  withCronContext:
    (_name: string, handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request) =>
      handler(req, {
        log: { info: h.logInfo, error: h.logError, warn: vi.fn() },
        requestId: 'req_test',
      }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ rpc: h.rpc })),
}))

import { GET, maxDuration } from '../route'

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/sandbox/cleanup/cron')
}

function batch(cleaned: number, failed = 0, orphans = 0) {
  return { data: { cleaned, failed, orphans_removed: orphans }, error: null }
}

describe('GET /api/sandbox/cleanup/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('reserves enough function time for the batch loop', () => {
    expect(maxDuration).toBe(300)
  })

  it('loops full batches and stops on the first partial one, aggregating totals', async () => {
    h.rpc
      .mockResolvedValueOnce(batch(10))
      .mockResolvedValueOnce(batch(10, 0, 0))
      .mockResolvedValueOnce(batch(3, 1, 2))
      .mockResolvedValueOnce(batch(0))

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(h.rpc).toHaveBeenCalledWith('cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: 10,
    })
    // Third batch still made progress (cleaned + orphans > 0), so a fourth
    // call runs and returns zero progress, ending the loop.
    expect(h.rpc).toHaveBeenCalledTimes(4)
    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      cleaned: 23,
      failed: 1,
      orphans_removed: 2,
      batches: 4,
    })
  })

  it('stops immediately when the backlog is empty', async () => {
    h.rpc.mockResolvedValue(batch(0))

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(body.batches).toBe(1)
    expect(h.logInfo).toHaveBeenCalled()
    expect(h.logError).not.toHaveBeenCalled()
  })

  it('stops when a batch yields only failures, and logs at error level', async () => {
    h.rpc.mockResolvedValueOnce(batch(0, 4, 0))

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(body.failed).toBe(4)
    expect(h.logError).toHaveBeenCalledWith(
      'sandbox cleanup completed with failures',
      expect.objectContaining({ failed: 4 }),
    )
  })

  it('still accepts the legacy bare-integer return shape', async () => {
    h.rpc.mockResolvedValueOnce({ data: 5, error: null }).mockResolvedValueOnce(batch(0))

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.cleaned).toBe(5)
  })

  it('returns an error envelope when the RPC fails mid-loop', async () => {
    h.rpc
      .mockResolvedValueOnce(batch(10))
      .mockResolvedValueOnce({ data: null, error: { message: 'boom', code: 'XX000' } })

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBeDefined()
    expect(h.logError).toHaveBeenCalled()
  })

  it('returns an error when Supabase configuration is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(body.error).toBeDefined()
  })
})
