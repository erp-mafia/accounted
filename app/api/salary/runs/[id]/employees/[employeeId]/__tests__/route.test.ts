import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// ── Mocks ────────────────────────────────────────────────────
// The route is wrapped in withRouteContext. We inject a queued Supabase mock
// through requireAuth and mock the company/write helpers the wrapper uses.

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: (x: string) => x,
  maskPersonnummer: (x: string) => x,
}))

import { PATCH } from '../route'
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

describe('PATCH /api/salary/runs/[id]/employees/[employeeId]: monthly salary edit', () => {
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

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('updates the per-run monthly salary while the run is a draft', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      {
        data: { id: 'sre-1', employment_degree: 100, salary_type: 'monthly', monthly_salary: 30000 },
      }, // salary_run_employees update
      { data: null }, // salary_line_items Grundlön refresh
    ])

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { monthly_salary: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.monthly_salary).toBe(30000)
  })

  it('allows a zero monthly salary (nollkörning) on a draft', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: 'sre-1', employment_degree: 100, salary_type: 'monthly', monthly_salary: 0 } },
      { data: null },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 0 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('rejects a monthly salary edit when the run is no longer a draft', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'review' } }, // not a draft
    ])

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000 },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('utkast')
  })

  it('rejects mixing a salary edit with a tax override in one request', async () => {
    authed()

    const request = createMockRequest('/api/salary/runs/run-1/employees/emp-1', {
      method: 'PATCH',
      body: { monthly_salary: 30000, tax_withheld_override: 5000, reason: 'test' },
    })
    const response = await PATCH(
      request,
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })
})
