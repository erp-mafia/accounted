import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'
import { getErrorMessage } from '@/lib/errors/get-error-message'

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

const CALCULATED_DRAFT = {
  id: 'run-1',
  status: 'draft',
  calculation_params: { configYear: 2026, avgifterTotal: 0.3142 },
}
const BREAKDOWN = { steps: [{ label: 'Bruttolön', formula: '45556', output: 45556 }] }

function rosterRow(overrides: Record<string, unknown> = {}) {
  return {
    employee_id: 'emp-1',
    calculation_breakdown: BREAKDOWN,
    employee: { first_name: 'Anna', last_name: 'A', f_skatt_status: 'a_skatt' },
    ...overrides,
  }
}

function authed() {
  const mock = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: mock.supabase as never,
    error: null,
  })
  return mock
}

function review() {
  return POST(
    createMockRequest('/api/salary/runs/run-1/review', { method: 'POST' }),
    createMockRouteParams({ id: 'run-1' }),
  )
}

describe('POST /api/salary/runs/[id]/review', () => {
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
    const response = await review()
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await review()
    expect(response.status).toBe(403)
  })

  it('moves a calculated draft run to review', async () => {
    const { enqueueMany, findCalls } = authed()
    enqueueMany([
      { data: CALCULATED_DRAFT }, // salary_runs: the draft
      { data: [rosterRow()] }, // salary_run_employees: calculated roster
      { data: { id: 'run-1', status: 'review' } }, // update draft → review
    ])
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(await review())
    expect(status).toBe(200)
    expect(body.data.status).toBe('review')
    // The roster read is scoped to the company, not only to the run id.
    expect(findCalls('salary_run_employees', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('moves a calculated empty roster (a nolldeklaration) to review', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: CALCULATED_DRAFT },
      { data: [] },
      { data: { id: 'run-1', status: 'review' } },
    ])
    const response = await review()
    expect(response.status).toBe(200)
  })

  it('surfaces an F-skatt warning when an employee is unverified', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: CALCULATED_DRAFT },
      { data: [rosterRow({ employee: { first_name: 'Anna', last_name: 'A', f_skatt_status: 'not_verified' } })] },
      { data: { id: 'run-1', status: 'review' } },
    ])
    const { status, body } = await parseJsonResponse<{ warnings?: string[] }>(await review())
    expect(status).toBe(200)
    expect(body.warnings?.[0]).toContain('F-skatt ej verifierad')
  })

  it('returns 400 when the run is missing or not a draft, and writes nothing', async () => {
    const { enqueueMany, findCalls } = authed()
    enqueueMany([{ data: null }]) // no draft row with this id in the company
    const { status, body } = await parseJsonResponse<{ error: string }>(await review())
    expect(status).toBe(400)
    expect(body.error).toContain('utkaststatus')
    expect(findCalls('salary_runs', 'update')).toHaveLength(0)
  })

  it('returns 400 when the run left draft between the read and the update', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: CALCULATED_DRAFT },
      { data: [rosterRow()] },
      { data: null, error: { message: 'no rows' } }, // update finds no draft row
    ])
    const { status, body } = await parseJsonResponse<{ error: string }>(await review())
    expect(status).toBe(400)
    expect(body.error).toContain('utkaststatus')
  })

  it('refuses a draft whose payment date change cleared the calculation (crm#1001)', async () => {
    // The state the payment-date PATCH leaves: calculation_params and the
    // figures stay, every roster row's breakdown is gone.
    const { enqueueMany, findCalls } = authed()
    enqueueMany([
      { data: CALCULATED_DRAFT },
      { data: [rosterRow({ calculation_breakdown: null })] },
    ])
    const response = await review()
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: { employees: string[] } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SALARY_RUN_NOT_CALCULATED')
    expect(body.error.details.employees).toEqual(['Anna A'])
    // What the run page's toast shows: the reason and the remedy, by name.
    const toast = getErrorMessage(body, { context: 'salary', statusCode: 400 })
    expect(toast).toContain('Beräkningen är inte aktuell för Anna A')
    expect(toast).toContain('beräkna om')
    // The run stays a draft, where it can be calculated again.
    expect(findCalls('salary_runs', 'update')).toHaveLength(0)
  })

  it('names only the employees without a current calculation', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: CALCULATED_DRAFT },
      {
        data: [
          rosterRow(),
          rosterRow({
            employee_id: 'emp-2',
            calculation_breakdown: null,
            employee: { first_name: 'Erik', last_name: 'E', f_skatt_status: 'a_skatt' },
          }),
        ],
      },
    ])
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { employees: string[] } }
    }>(await review())
    expect(status).toBe(400)
    expect(body.error.details.employees).toEqual(['Erik E'])
  })

  it('refuses a draft that was never calculated', async () => {
    const { enqueueMany, findCalls } = authed()
    enqueueMany([
      { data: { ...CALCULATED_DRAFT, calculation_params: null } },
      { data: [rosterRow({ calculation_breakdown: null })] },
    ])
    const response = await review()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SALARY_RUN_NOT_CALCULATED')
    expect(getErrorMessage(body, { context: 'salary', statusCode: 400 })).toContain('inte beräknad')
    expect(findCalls('salary_runs', 'update')).toHaveLength(0)
  })
})
