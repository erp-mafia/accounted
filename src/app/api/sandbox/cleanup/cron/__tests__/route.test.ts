/**
 * Tests for the sandbox cleanup cron route: the run loops small RPC batches
 * (each PostgREST statement gets its own 8s window; a function-level
 * statement_timeout cannot lift it), skips past failed users with the offset
 * the RPC reports (20260927220000; before it, ten failing users at the head
 * of the queue stopped every run after one batch), stops when the backlog is
 * empty, aggregates totals across batches, accepts the older return shapes,
 * and logs failures at error level, one line per failed user with the reason
 * the RPC reports (20261109185036): the failure mode this route chain fixes
 * was months of silently swallowed cleanup errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/api/with-cron-context', () => ({
  withServiceCronContext:
    (_name: string, handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request) =>
      handler(req, {
        log: { info: h.logInfo, error: h.logError, warn: vi.fn() },
        requestId: 'req_test',
        supabase: { rpc: h.rpc },
      }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ rpc: h.rpc })),
}))

import { GET, maxDuration } from '../route'
import { createCronRequest } from '@/tests/helpers'

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

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
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
      kept: 0,
      orphans_removed: 2,
      batches: 4,
    })
  })

  it('stops immediately when the backlog is empty', async () => {
    h.rpc.mockResolvedValue(batch(0))

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
    const body = await res.json()

    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(body.batches).toBe(1)
    expect(h.logInfo).toHaveBeenCalled()
    expect(h.logError).not.toHaveBeenCalled()
  })

  it('skips past failed users with the reported offset instead of stopping', async () => {
    h.rpc
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 10, orphans_removed: 0, attempted: 10, next_offset: 10 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { cleaned: 9, failed: 1, orphans_removed: 0, attempted: 10, next_offset: 11 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 0, orphans_removed: 0, attempted: 0, next_offset: 11 },
        error: null,
      })

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
    const body = await res.json()

    expect(h.rpc).toHaveBeenCalledTimes(3)
    // The first call never names p_offset, so a deploy that lands before the
    // migration still resolves to the two-argument function.
    expect(h.rpc).toHaveBeenNthCalledWith(1, 'cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: 10,
    })
    expect(h.rpc).toHaveBeenNthCalledWith(2, 'cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: 10,
      p_offset: 10,
    })
    expect(h.rpc).toHaveBeenNthCalledWith(3, 'cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: 10,
      p_offset: 11,
    })
    expect(body).toEqual({ success: true, cleaned: 9, failed: 11, kept: 0, orphans_removed: 0, batches: 3 })
    expect(h.logError).toHaveBeenCalledWith(
      'sandbox cleanup completed with failures',
      expect.objectContaining({ failed: 11 }),
    )
  })

  it('logs every failed user with the reason the RPC reports, and keeps the reasons out of the body', async () => {
    const refused = {
      user_id: '00000000-0000-4000-8000-000000000001',
      kind: 'sandbox',
      sqlstate: 'P0001',
      message: 'User 00000000-0000-4000-8000-000000000001 has data in a company that is not a sandbox',
      context: 'PL/pgSQL function cleanup_sandbox_user(uuid) line 30 at RAISE',
    }
    const blocked = {
      user_id: '00000000-0000-4000-8000-000000000002',
      kind: 'sandbox',
      sqlstate: '23503',
      message:
        'update or delete on table "companies" violates foreign key constraint "skatteverket_api_audit_log_company_id_fkey" on table "skatteverket_api_audit_log"',
      table: 'public.skatteverket_api_audit_log',
      constraint: 'skatteverket_api_audit_log_company_id_fkey',
    }
    h.rpc
      .mockResolvedValueOnce({
        data: {
          cleaned: 1,
          failed: 2,
          orphans_removed: 0,
          attempted: 3,
          next_offset: 2,
          // Unknown keys and non-string values never reach the log.
          failures: [refused, { ...blocked, context: 42, detail: 'Failing row contains (...)' }, 'not-an-object'],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 0, orphans_removed: 0, attempted: 0, next_offset: 2, failures: [] },
        error: null,
      })

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
    const body = await res.json()

    // The user with data in a real company is kept, not failed: counted and
    // logged at info. The teardown gap is the one failure.
    expect(body).toEqual({ success: true, cleaned: 1, failed: 1, kept: 1, orphans_removed: 0, batches: 2 })
    expect(h.logInfo).toHaveBeenCalledWith('sandbox users kept: they have data in a real company', {
      kept: 1,
      user_ids: [refused.user_id],
    })
    expect(h.logError).not.toHaveBeenCalledWith('sandbox teardown failed', { failure: refused })
    expect(h.logError).toHaveBeenCalledWith('sandbox teardown failed', { failure: blocked })
    expect(h.logError).toHaveBeenCalledWith(
      'sandbox cleanup completed with failures',
      expect.objectContaining({ failed: 1, kept: 1, failures_logged: 1, failures_omitted: 0 }),
    )
    expect(h.logError).toHaveBeenCalledTimes(2)
  })

  it('a night where the only refused users have data in a real company logs nothing at error level', async () => {
    const keptUser = (n: number) => ({
      user_id: `00000000-0000-4000-8000-00000000000${n}`,
      kind: 'sandbox',
      sqlstate: 'P0001',
      message: `User 00000000-0000-4000-8000-00000000000${n} has data in a company that is not a sandbox`,
    })
    h.rpc
      .mockResolvedValueOnce({
        data: { cleaned: 4, failed: 2, orphans_removed: 0, attempted: 6, next_offset: 2, failures: [keptUser(1), keptUser(2)] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 0, orphans_removed: 0, attempted: 0, next_offset: 2, failures: [] },
        error: null,
      })

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, cleaned: 4, failed: 0, kept: 2, orphans_removed: 0, batches: 2 })
    expect(h.logError).not.toHaveBeenCalled()
    expect(h.logInfo).toHaveBeenCalledWith('sandbox users kept: they have data in a real company', {
      kept: 2,
      user_ids: [keptUser(1).user_id, keptUser(2).user_id],
    })
    expect(h.logInfo).toHaveBeenCalledWith('sandbox cleanup summary', expect.objectContaining({ failed: 0, kept: 2 }))
    // The kept users stay at the head of the queue: the next batch starts after them.
    expect(h.rpc).toHaveBeenNthCalledWith(2, 'cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: 10,
      p_offset: 2,
    })
  })

  it('logs at most twenty failed users per run and counts the rest', async () => {
    const failures = Array.from({ length: 25 }, (_, i) => ({
      user_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      kind: 'sandbox',
      sqlstate: '23503',
      message: 'violates foreign key constraint',
    }))
    h.rpc
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 25, orphans_removed: 0, attempted: 25, next_offset: 25, failures },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 0, orphans_removed: 0, attempted: 0, next_offset: 25, failures: [] },
        error: null,
      })

    await GET(createCronRequest('/api/sandbox/cleanup/cron'))

    const perUser = h.logError.mock.calls.filter(([msg]) => msg === 'sandbox teardown failed')
    expect(perUser).toHaveLength(20)
    expect(h.logError).toHaveBeenCalledWith(
      'sandbox cleanup completed with failures',
      expect.objectContaining({ failed: 25, failures_logged: 20, failures_omitted: 5 }),
    )
  })

  it('keeps going while only orphans are removed, and stops once nothing is attempted', async () => {
    h.rpc
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 0, orphans_removed: 3, attempted: 0, next_offset: 0 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { cleaned: 0, failed: 0, orphans_removed: 0, attempted: 0, next_offset: 0 },
        error: null,
      })

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
    const body = await res.json()

    expect(h.rpc).toHaveBeenCalledTimes(2)
    expect(body.orphans_removed).toBe(3)
  })

  it('with the older summary shape, stops when a batch yields only failures and logs at error level', async () => {
    h.rpc.mockResolvedValueOnce(batch(0, 4, 0))

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
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

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.cleaned).toBe(5)
  })

  it('returns an error envelope when the RPC fails mid-loop', async () => {
    h.rpc
      .mockResolvedValueOnce(batch(10))
      .mockResolvedValueOnce({ data: null, error: { message: 'boom', code: 'XX000' } })

    const res = await GET(createCronRequest('/api/sandbox/cleanup/cron'))
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBeDefined()
    expect(h.logError).toHaveBeenCalled()
  })

})
