/**
 * POST /api/salary/runs/{id}/calculate: the dashboard door over
 * runSalaryCalculation. The calculation itself is tested in
 * lib/salary/__tests__; here the door's contract: auth, the success
 * envelope, and that a refusal reaches the person with its own sentence
 * (issue #85: vacation days the law and the data cannot price).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse, createMockRouteParams } from '@/tests/helpers'
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
vi.mock('@/lib/salary/run-calculation', () => ({ runSalaryCalculation: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { runSalaryCalculation } from '@/lib/salary/run-calculation'

function authed() {
  const mock = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1', email: 'test@test.se' } as never,
    supabase: mock.supabase as never,
    error: null,
  })
  return mock
}

function calculate() {
  return POST(
    createMockRequest('/api/salary/runs/run-1/calculate', { method: 'POST' }),
    createMockRouteParams({ id: 'run-1' }),
  )
}

const UNDETERMINED_SV =
  'Vera Testsson: semesterlönen enligt procentregeln är 12 % av lönen under intjänandeåret 2025/2026 (Semesterlagen 16 b §), men Accounted saknar godkända lönebesked för 2025-04.'

describe('POST /api/salary/runs/[id]/calculate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await calculate()
    expect(response.status).toBe(401)
    expect(runSalaryCalculation).not.toHaveBeenCalled()
  })

  it('returns the calculated run and its warnings', async () => {
    authed()
    vi.mocked(runSalaryCalculation).mockResolvedValue({
      ok: true,
      run: { id: 'run-1', status: 'draft' },
      warnings: ['Semesterlön för uttagna semesterdagar har räknats fram för Vera Testsson.'],
    })
    const response = await calculate()
    const { status, body } = await parseJsonResponse<{ data: { id: string }; warnings: string[] }>(response)
    expect(status).toBe(200)
    expect(body.data.id).toBe('run-1')
    expect(body.warnings).toHaveLength(1)
    expect(vi.mocked(runSalaryCalculation).mock.calls[0][0]).toMatchObject({ companyId: 'company-1', salaryRunId: 'run-1' })
  })

  it('returns 404 for a run that is not the company\'s', async () => {
    authed()
    vi.mocked(runSalaryCalculation).mockResolvedValue({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    const response = await calculate()
    expect(response.status).toBe(404)
  })

  it('a vacation-pay refusal is a 400 that names the employee and the fix, in Swedish and English', async () => {
    authed()
    vi.mocked(runSalaryCalculation).mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_VACATION_PAY_UNDETERMINED',
      details: {
        reason: 'vacation_pay_undetermined',
        issues: [{ employee: 'Vera Testsson', message: 'sv', message_en: 'en' }],
      },
      messageSv: UNDETERMINED_SV,
      messageEn: 'Vera Testsson: procentregeln semesterlön is 12 % of the pay of the earning year 2025/2026.',
    })
    const response = await calculate()
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string; details: { issues: unknown[] } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SALARY_RUN_VACATION_PAY_UNDETERMINED')
    expect(body.error.message).toBe(UNDETERMINED_SV)
    expect(body.error.message_en).toContain('procentregeln semesterlön')
    expect(body.error.details.issues).toHaveLength(1)
    // What the run page's toast shows (getErrorMessage), in both locales.
    expect(getErrorMessage(body, { context: 'salary', statusCode: 400 })).toBe(UNDETERMINED_SV)
    expect(getErrorMessage(body, { context: 'salary', statusCode: 400, locale: 'en' })).toContain('procentregeln semesterlön')
  })
})
