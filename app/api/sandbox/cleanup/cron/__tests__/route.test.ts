/**
 * Tests for the sandbox cleanup cron route: the RPC's jsonb summary
 * ({cleaned, failed, orphans_removed}, migration 20260807130000) is passed
 * through, the legacy bare-integer shape is still accepted (deploy/migration
 * ordering), and per-user failures are logged at error level: the failure
 * mode this fixes was months of silently swallowed cleanup errors.
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

describe('GET /api/sandbox/cleanup/cron', () => {
  it('reserves enough function time for a full batch', () => {
    // 60 users at ~3s each must fit inside the route budget and the RPC's
    // 290s statement_timeout (migration 20260807150000).
    expect(maxDuration).toBe(300)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('passes the jsonb summary through and logs at info level when nothing failed', async () => {
    h.rpc.mockResolvedValue({
      data: { cleaned: 3, failed: 0, orphans_removed: 2 },
      error: null,
    })

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(h.rpc).toHaveBeenCalledWith('cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: 60,
    })
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, cleaned: 3, failed: 0, orphans_removed: 2 })
    expect(h.logInfo).toHaveBeenCalled()
    expect(h.logError).not.toHaveBeenCalled()
  })

  it('logs at error level when the summary reports failures', async () => {
    h.rpc.mockResolvedValue({
      data: { cleaned: 1, failed: 4, orphans_removed: 0 },
      error: null,
    })

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.failed).toBe(4)
    expect(h.logError).toHaveBeenCalledWith(
      'sandbox cleanup completed with failures',
      expect.objectContaining({ failed: 4 }),
    )
  })

  it('still accepts the legacy bare-integer return shape', async () => {
    h.rpc.mockResolvedValue({ data: 5, error: null })

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, cleaned: 5, failed: 0, orphans_removed: 0 })
  })

  it('returns an error envelope when the RPC fails', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { message: 'boom', code: 'XX000' },
    })

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
