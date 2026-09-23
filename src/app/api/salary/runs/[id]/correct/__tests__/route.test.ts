import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// The route is wrapped in withRouteContext. Auth/company/write are injected via
// mocks; the storno engine and payslip-link revocation are stubbed.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({ reverseEntry: vi.fn() }))
vi.mock('@/lib/salary/payslips/links', () => ({ revokeLinksForRun: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany }
}

describe('POST /api/salary/runs/[id]/correct', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/correct', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/correct', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('creates a correction run for a booked original', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      // original booked run (no entry ids → no reversal loop)
      {
        data: {
          id: 'run-1',
          status: 'booked',
          period_year: 2026,
          period_month: 3,
          payment_date: '2026-03-25',
          voucher_series: 'A',
          salary_entry_id: null,
          avgifter_entry_id: null,
          vacation_entry_id: null,
          pension_entry_id: null,
        },
      },
      { data: null }, // update original → corrected
      { data: { id: 'corr-1', period_year: 2026, period_month: 3 } }, // insert correction run
      { data: [] }, // original employees (none to copy)
    ])

    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/correct', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string }; reversed_entry_count: number }>(
      response,
    )

    expect(status).toBe(201)
    expect(body.data.id).toBe('corr-1')
    expect(body.reversed_entry_count).toBe(0)
  })

  it('rejects correcting a run that is not booked', async () => {
    const { enqueueMany } = authed()
    enqueueMany([{ data: null, error: { message: 'no rows' } }]) // status filter excludes it

    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/correct', { method: 'POST' }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('bokförda')
  })
})
