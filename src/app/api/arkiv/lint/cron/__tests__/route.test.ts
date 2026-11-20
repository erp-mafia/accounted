import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => mockSupabase) }))
vi.mock('@/lib/arkiv/lint/run', () => ({ lintCompanies: vi.fn() }))
vi.mock('@/lib/arkiv/graph/snapshot', () => ({ markCompanyGraphStale: vi.fn(), refreshStaleGraphs: vi.fn(async () => ({ refreshed: 0, failed: 0 })) }))

// Only the error level is swapped: the run's one error line is asserted.
const logError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      error: logError,
    }),
  }
})

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { lintCompanies } from '@/lib/arkiv/lint/run'

const call = () => GET(new Request('http://localhost/api/arkiv/lint/cron'))

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'co-1,co-2'
})

afterEach(() => {
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
})

describe('GET /api/arkiv/lint/cron', () => {
  it('rejects a request without the cron secret', async () => {
    ;(verifyCronSecret as ReturnType<typeof vi.fn>).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(lintCompanies).not.toHaveBeenCalled()
  })

  it('lints every company in the rollout and sums what it filed', async () => {
    ;(lintCompanies as ReturnType<typeof vi.fn>).mockResolvedValue({
      'co-1': { findings: 3, opened: 1, closed: 2, autonomy: 1 },
      'co-2': { error: 'facts fetch failed: timeout' },
    })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, companies: 2, findings: 3, opened: 1, closed: 2, failed: 1, graphs: { refreshed: 0, failed: 0 } })
    expect(lintCompanies).toHaveBeenCalledWith(mockSupabase, ['co-1', 'co-2'], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    // A failed company is an error somebody sees, once per run.
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('arkiv lint failed for some companies', {
      failed: 1,
      companies: ['co-2'],
      firstReason: 'facts fetch failed: timeout',
    })
  })

  it('logs no error on a clean night', async () => {
    ;(lintCompanies as ReturnType<typeof vi.fn>).mockResolvedValue({
      'co-1': { findings: 0, opened: 0, closed: 0, autonomy: 1 },
      'co-2': { findings: 1, opened: 1, closed: 0, autonomy: 1 },
    })
    expect((await parseJsonResponse(await call())).status).toBe(200)
    expect(logError).not.toHaveBeenCalled()
  })

  it('answers 500 when every company failed', async () => {
    ;(lintCompanies as ReturnType<typeof vi.fn>).mockResolvedValue({
      'co-1': { error: 'facts fetch failed: timeout' },
      'co-2': { error: 'facts fetch failed: timeout' },
    })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false, companies: 2, failed: 2 })
  })

  it('does nothing when no company is in the rollout', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    ;(lintCompanies as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const { body } = await parseJsonResponse(await call())
    expect(body).toMatchObject({ ok: true, companies: 0 })
  })
})
