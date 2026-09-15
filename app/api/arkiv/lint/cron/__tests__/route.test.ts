import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => mockSupabase) }))
vi.mock('@/lib/arkiv/lint/run', () => ({ lintCompanies: vi.fn() }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { lintCompanies } from '@/lib/arkiv/lint/run'

const call = () => GET(new Request('http://localhost/api/arkiv/lint/cron'))

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
  process.env.ARKIV_COMPANY_IDS = 'co-1,co-2'
})

afterEach(() => {
  delete process.env.ARKIV_COMPANY_IDS
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
    expect(body).toEqual({ ok: true, companies: 2, findings: 3, opened: 1, closed: 2, failed: 1 })
    expect(lintCompanies).toHaveBeenCalledWith(mockSupabase, ['co-1', 'co-2'], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('does nothing when no company is in the rollout', async () => {
    delete process.env.ARKIV_COMPANY_IDS
    ;(lintCompanies as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const { body } = await parseJsonResponse(await call())
    expect(body).toMatchObject({ ok: true, companies: 0 })
  })
})
