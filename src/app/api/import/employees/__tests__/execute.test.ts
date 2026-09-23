import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

const mockCreateEmployee = vi.fn()
vi.mock('@/lib/salary/employee-commands', () => ({
  createEmployee: (...a: unknown[]) => mockCreateEmployee(...a),
}))

const mockSetOpeningBalances = vi.fn()
vi.mock('@/lib/salary/opening-balances', () => ({
  setOpeningBalancesBulk: (...a: unknown[]) => mockSetOpeningBalances(...a),
}))

import { POST } from '../execute/route'

const PNR_A = '190001010008'
const PNR_B = '190203040001'
const mockUser = { id: 'user-1', email: 'test@test.se' }
// withRouteContext handlers take (request, routeContext); this route has no params.
const routeCtx = { params: Promise.resolve({}) } as never

function employee(overrides: Record<string, unknown> = {}) {
  return {
    first_name: 'Test',
    last_name: 'Personson',
    personnummer: PNR_A,
    employment_type: 'employee',
    employment_start: '2026-01-01',
    employment_degree: 100,
    hours_per_week: 40,
    workdays_per_week: 5,
    salary_type: 'monthly',
    monthly_salary: 30000,
    tax_table_number: 30,
    tax_column: 1,
    tax_municipality: 'Stockholm',
    is_sidoinkomst: false,
    f_skatt_status: 'a_skatt',
    vacation_rule: 'procentregeln',
    vacation_days_per_year: 25,
    ...overrides,
  }
}

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/employees/execute', { method: 'POST', body })
}

describe('POST /api/import/employees/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
    let n = 0
    mockCreateEmployee.mockImplementation(async () => ({
      ok: true,
      data: { employee_id: `emp-${++n}`, first_name: 'x', last_name: 'y', personnummer_masked: 'm', is_active: true },
    }))
    mockSetOpeningBalances.mockResolvedValue({ ok: true, data: { count: 1, rows: [] } })
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ rows: [{ row_index: 2, employee: employee(), opening_balances: null }] }), routeCtx)
    expect(res.status).toBe(401)
  })

  it('returns 400 for an empty rows array', async () => {
    const res = await POST(makeRequest({ rows: [] }), routeCtx)
    expect(res.status).toBe(400)
  })

  it('creates employees through createEmployee with the personnummer encrypted', async () => {
    const res = await POST(makeRequest({ rows: [{ row_index: 2, employee: employee(), opening_balances: null }] }), routeCtx)
    const { status, body } = await parseJsonResponse<{ data: { created: number; failed: number; success: boolean } }>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.success).toBe(true)
    expect(mockCreateEmployee).toHaveBeenCalledTimes(1)
    const args = mockCreateEmployee.mock.calls[0][1] as { companyId: string; userId: string; input: Record<string, unknown> }
    expect(args.companyId).toBe('company-1')
    expect(args.userId).toBe('user-1')
    expect(args.input.personnummer).toBeUndefined()
    expect(args.input.personnummer_last4).toBe('0008')
    expect(typeof args.input.personnummer_encrypted).toBe('string')
    expect(args.input.personnummer_encrypted).not.toBe(PNR_A)
    expect(mockSetOpeningBalances).not.toHaveBeenCalled()
  })

  it('fails one invalid row on its own line and still creates the rest', async () => {
    const res = await POST(makeRequest({
      rows: [
        { row_index: 2, employee: employee({ monthly_salary: 0 }), opening_balances: null },
        { row_index: 3, employee: employee({ personnummer: PNR_B }), opening_balances: null },
      ],
    }), routeCtx)
    const { status, body } = await parseJsonResponse<{ data: { created: number; failed: number; errors: Array<{ row_index: number; reason: string }> } }>(res)
    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.failed).toBe(1)
    expect(body.data.errors[0].row_index).toBe(2)
    expect(body.data.errors[0].reason).toMatch(/Månadslön/)
  })

  it('skips a personnummer that already exists on the roster', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'emp-old', first_name: 'Redan', last_name: 'Här', personnummer: encryptPersonnummer(PNR_A), is_active: true },
    ])
    const res = await POST(makeRequest({ rows: [{ row_index: 2, employee: employee(), opening_balances: null }] }), routeCtx)
    const { body } = await parseJsonResponse<{ data: { created: number; skipped: number } }>(res)
    expect(body.data.created).toBe(0)
    expect(body.data.skipped).toBe(1)
    expect(mockCreateEmployee).not.toHaveBeenCalled()
  })

  it('skips when createEmployee reports a duplicate personnummer race', async () => {
    mockCreateEmployee.mockResolvedValue({ ok: false, code: 'EMPLOYEE_DUPLICATE_PERSONNUMMER' })
    const res = await POST(makeRequest({ rows: [{ row_index: 2, employee: employee(), opening_balances: null }] }), routeCtx)
    const { body } = await parseJsonResponse<{ data: { created: number; skipped: number; failed: number } }>(res)
    expect(body.data.skipped).toBe(1)
    expect(body.data.failed).toBe(0)
  })

  it('writes cutover balances for created rows in one bulk call', async () => {
    const res = await POST(makeRequest({
      rows: [{
        row_index: 2,
        employee: employee({ employment_start: '2025-01-01' }),
        opening_balances: { cutover_date: '2026-09-01', ytd_gross: 240000, ytd_tax: 60000, ytd_net: 180000, vacation_paid_days_remaining: 12 },
      }],
    }), routeCtx)
    const { body } = await parseJsonResponse<{ data: { created: number; opening_balances_set: number; notices: Array<{ code: string }> } }>(res)
    expect(body.data.created).toBe(1)
    expect(body.data.opening_balances_set).toBe(1)
    expect(mockSetOpeningBalances).toHaveBeenCalledTimes(1)
    const args = mockSetOpeningBalances.mock.calls[0][1] as { items: Array<Record<string, unknown>> }
    expect(args.items[0].employee_id).toBe('emp-1')
    expect(args.items[0].ytd_gross).toBe(240000)
    expect(body.data.notices).toContainEqual({ code: 'employees_opening_balances_set', severity: 'info', params: { count: 1 } })
  })

  it('reports a rejected cutover block per row while keeping the employee created', async () => {
    mockSetOpeningBalances.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      itemErrors: [{ index: 0, employee_id: 'emp-1', code: 'CUTOVER_BEFORE_EMPLOYMENT_START', message: 'cutover_date före anställningsdatum' }],
    })
    const res = await POST(makeRequest({
      rows: [{
        row_index: 2,
        employee: employee(),
        opening_balances: { cutover_date: '2026-09-01', ytd_gross: 1000, ytd_tax: 0, ytd_net: 0, vacation_paid_days_remaining: 0 },
      }],
    }), routeCtx)
    const { body } = await parseJsonResponse<{ data: { created: number; failed: number; success: boolean; errors: Array<{ reason: string }>; notices: Array<{ code: string }> } }>(res)
    expect(body.data.created).toBe(1)
    expect(body.data.failed).toBe(1)
    expect(body.data.success).toBe(false)
    expect(body.data.errors[0].reason).toMatch(/ingående saldon kunde inte sparas/)
    expect(body.data.notices.map((n) => n.code)).toContain('employees_opening_balances_failed')
  })
})
