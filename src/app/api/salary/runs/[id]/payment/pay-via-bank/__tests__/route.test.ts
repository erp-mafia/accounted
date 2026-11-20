import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const prepare = vi.hoisted(() => vi.fn())
vi.mock('@/lib/salary/payment/pay-via-bank', () => ({ prepareSalaryBankPayment: prepare }))

import { POST } from '../route'

const RUN = '11111111-1111-4111-8111-111111111111'
const ACCOUNT = '33333333-3333-4333-8333-333333333333'
const params = { params: Promise.resolve({ id: RUN }) }
const post = (body: unknown) => createMockRequest(`/api/salary/runs/${RUN}/payment/pay-via-bank`, { method: 'POST', body })

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})

describe('POST /api/salary/runs/[id]/payment/pay-via-bank', () => {
  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await POST(post({ cash_account_id: ACCOUNT }), params)
    expect(response.status).toBe(401)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('answers 400 for a missing account, a date that is no date and a confirmation that is no boolean', async () => {
    for (const body of [
      {},
      { cash_account_id: 'acct-1' },
      { cash_account_id: ACCOUNT, execution_date: '27/10/2026' },
      { cash_account_id: ACCOUNT, confirmed_unpaid: 'yes' },
    ]) {
      const response = await POST(post(body), params)
      expect(response.status).toBe(400)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('creates the drafts and answers 201 with them', async () => {
    const data = { orders: [{ id: 'order-1', purpose: 'salary' }], replaced_draft_ids: [], warnings: [], total: 28291 }
    prepare.mockResolvedValue({ ok: true, data })

    const { status, body } = await parseJsonResponse<{ data: typeof data }>(
      await POST(post({ cash_account_id: ACCOUNT, execution_date: '2026-10-27', confirmed_unpaid: true }), params),
    )

    expect(status).toBe(201)
    expect(body.data).toEqual(data)
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({
        salaryRunId: RUN,
        cashAccountId: ACCOUNT,
        executionDate: '2026-10-27',
        confirmedUnpaid: true,
        dryRun: false,
        today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
  })

  it('answers the preview of a dry run with 200, the day left to the service', async () => {
    prepare.mockResolvedValue({ ok: true, dryRun: true, preview: { total: 56291 } })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await POST(post({ cash_account_id: ACCOUNT, dry_run: true }), params))
    expect(status).toBe(200)
    expect(body.data).toEqual({ total: 56291 })
    expect(prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ executionDate: null, confirmedUnpaid: false, dryRun: true }))
  })

  it('answers 404 for a run the company does not have', async () => {
    prepare.mockResolvedValue({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ cash_account_id: ACCOUNT }), params))
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('answers a refusal in Swedish with its code and details', async () => {
    prepare.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING',
      details: { employees: [{ employee_id: 'emp-anna', name: 'Anna Andersson' }] },
    })
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ cash_account_id: ACCOUNT }), params))
    expect(status).toBe(422)
    expect(body.error.code).toBe('SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING')
    expect(body.error.message).toMatch(/saknar clearingnummer eller kontonummer/)
    expect(body.error.details).toEqual({ employees: [{ employee_id: 'emp-anna', name: 'Anna Andersson' }] })
  })

  it('passes the service\'s own Swedish sentence through for an account the bank cannot pay to', async () => {
    prepare.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_INVALID',
      messageSv: 'Bertil Berg: clearingnumret ska ha fyra eller fem siffror.',
      details: { employees: [{ employee_id: 'emp-bertil', name: 'Bertil Berg', problem: 'clearing_format' }] },
    })
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ cash_account_id: ACCOUNT }), params))
    expect(status).toBe(422)
    expect(body.error.message).toBe('Bertil Berg: clearingnumret ska ha fyra eller fem siffror.')
  })
})
