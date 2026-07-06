import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// ── Mocks ────────────────────────────────────────────────────
// The route is wrapped in withRouteContext, which resolves auth via
// requireAuth() (the only path that enforces MFA/AAL2 on hosted) and the active
// company via getActiveCompanyId(). Mock those, not createClient/getUser.

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: vi.fn((v: string) => v),
  maskPersonnummer: vi.fn(() => '19900101-****'),
}))

import { DELETE, GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

// ── Test data ────────────────────────────────────────────────

const mockUser = { id: 'user-1', email: 'test@test.se' }

// ── Tests ────────────────────────────────────────────────────

describe('DELETE /api/salary/runs/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: {} as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when salary run not found', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: null, error: { message: 'Not found' } }, // salary_runs lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toContain('hittades inte')
  })

  it('returns 400 when the run is not a draft (booked must be storno-reversed)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: { id: 'run-1', status: 'booked' } }, // salary_runs lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('utkast')
  })

  it('deletes a draft run and returns success', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })

    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      { data: null },                              // salary_runs delete (cascade handles children)
    ])

    const request = createMockRequest('/api/salary/runs/run-1', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'run-1', deleted: true })
  })
})

// ── GET detail additions (previous_run, corrected_by_run_id, deliveries) ────
//
// GET consumes queue entries in from() order. The run loads first; the rest
// fire together in a Promise.all, so their from() calls resolve in this order:
//   1 run, 2 employees, 3 settings (arbetsgivare), 4 previous-run lookup,
//   [corrected_by lookup when status is 'corrected'], deliveries,
//   [previous-run employees when found — nested after the lookup's await, so
//   it lands last].

const GET_RUN = {
  id: 'run-2',
  company_id: 'company-1',
  status: 'draft',
  period_year: 2026,
  period_month: 7,
  payment_date: '2026-07-25',
}

describe('GET /api/salary/runs/[id] — additive detail fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function authed(supabase: unknown) {
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: supabase as never,
      error: null,
    })
  }

  it('returns previous_run with effective (override-coalesced) values', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: GET_RUN },
      { data: [] }, // employees in this run
      { data: { org_number: null, entity_type: null } },
      { data: { id: 'run-1', period_year: 2026, period_month: 6 } }, // previous-run lookup
      { data: [] }, // deliveries
      {
        // previous-run employees — nested after the lookup's await, resolves last
        data: [
          {
            employee_id: 'emp-1',
            gross_salary: 35000,
            tax_withheld: 8000,
            tax_withheld_override: 7000,
            net_salary: 27000,
          },
        ],
      },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-2'),
      createMockRouteParams({ id: 'run-2' }),
    )
    const { status, body } = await parseJsonResponse<{
      data: {
        previous_run: {
          id: string
          by_employee: Record<string, { gross: number; tax: number; net: number }>
        } | null
        corrected_by_run_id: string | null
        payslip_deliveries_summary: { sent: number; failed: number; skipped: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.previous_run?.id).toBe('run-1')
    // Override coalesced: tax 7000, net compensated +1000
    expect(body.data.previous_run?.by_employee['emp-1']).toEqual({
      gross: 35000,
      tax: 7000,
      net: 28000,
    })
    expect(body.data.corrected_by_run_id).toBeNull()
    expect(body.data.payslip_deliveries_summary).toMatchObject({ sent: 0, failed: 0, skipped: 0 })
  })

  it('returns previous_run null on the first-ever run', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: GET_RUN },
      { data: [] },
      { data: null }, // settings
      { data: null }, // no previous booked run
      { data: [] }, // deliveries
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-2'),
      createMockRouteParams({ id: 'run-2' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { previous_run: unknown } }>(response)

    expect(status).toBe(200)
    expect(body.data.previous_run).toBeNull()
  })

  it('exposes corrected_by_run_id on corrected originals and counts latest deliveries', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { ...GET_RUN, status: 'corrected' } },
      { data: [] },
      { data: null }, // settings
      { data: null }, // previous booked run
      { data: { id: 'run-correction' } }, // corrected_by lookup
      {
        data: [
          // newest first (route orders sent_at desc): emp-1 latest = sent
          { employee_id: 'emp-1', status: 'sent', sent_at: '2026-07-01T10:00:00Z' },
          { employee_id: 'emp-1', status: 'failed', sent_at: '2026-06-30T10:00:00Z' },
          { employee_id: 'emp-2', status: 'skipped', sent_at: '2026-07-01T10:00:00Z' },
        ],
      },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-2'),
      createMockRouteParams({ id: 'run-2' }),
    )
    const { status, body } = await parseJsonResponse<{
      data: {
        corrected_by_run_id: string | null
        payslip_deliveries_summary: { sent: number; failed: number; skipped: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.corrected_by_run_id).toBe('run-correction')
    // Latest attempt per employee: emp-1 sent (failure superseded), emp-2 skipped
    expect(body.data.payslip_deliveries_summary).toMatchObject({
      sent: 1,
      failed: 0,
      skipped: 1,
    })
  })
})
