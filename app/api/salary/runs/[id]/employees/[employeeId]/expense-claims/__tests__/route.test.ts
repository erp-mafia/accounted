import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const URL = '/api/salary/runs/run-1/employees/emp-1/expense-claims'
const PARAMS = createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' })

function authed() {
  const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany, findCall }
}

describe('POST /api/salary/runs/[id]/employees/[employeeId]/expense-claims', () => {
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
    const response = await POST(createMockRequest(URL, { method: 'POST' }), PARAMS)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await POST(createMockRequest(URL, { method: 'POST' }), PARAMS)
    expect(response.status).toBe(403)
  })

  it('returns 404 with the structured code when the employee has no open claims', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs gate
      { data: { id: 'sre-1', employee_id: 'emp-1' } }, // salary_run_employees
      { data: [] }, // no registered claims
    ])
    const response = await POST(createMockRequest(URL, { method: 'POST' }), PARAMS)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS')
  })

  it('returns 400 once the run has left draft', async () => {
    const { enqueueMany } = authed()
    enqueueMany([{ data: { id: 'run-1', status: 'approved' } }])
    const response = await POST(createMockRequest(URL, { method: 'POST' }), PARAMS)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
  })

  it('adds the open claims as linked tax-free lines and returns 201', async () => {
    const { enqueueMany, findCall } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: 'sre-1', employee_id: 'emp-1' } },
      {
        data: [
          { id: 'c-a', description: 'Kabel', expense_date: '2026-06-01', amount_sek: 250.5, liability_account: '2820' },
        ],
      },
      { data: [] }, // nothing scheduled elsewhere
      { data: [{ id: 'li-1', source_expense_claim_id: 'c-a', amount: 250.5 }] },
    ])

    const response = await POST(createMockRequest(URL, { method: 'POST' }), PARAMS)
    const { status, body } = await parseJsonResponse<{
      data: { claim_count: number; total_sek: number; lines: Array<{ id: string }> }
    }>(response)

    expect(status).toBe(201)
    expect(body.data).toMatchObject({ claim_count: 1, total_sek: 250.5 })
    expect(body.data.lines[0].id).toBe('li-1')
    const [rows] = findCall('salary_line_items', 'insert') as [Array<Record<string, unknown>>]
    expect(rows[0]).toMatchObject({
      item_type: 'expense_reimbursement',
      source_expense_claim_id: 'c-a',
      account_number: '2820',
      is_taxable: false,
      is_avgift_basis: false,
    })
  })
})
