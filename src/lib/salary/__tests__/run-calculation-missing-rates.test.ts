/**
 * A run paid in a year without payroll rates answers a named failure instead
 * of throwing into the route's 500 (and the MCP tool's UNKNOWN_ERROR).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

vi.mock('../payroll-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payroll-config')>()
  return { ...actual, loadPayrollConfig: vi.fn() }
})

import { loadPayrollConfig, PayrollConfigMissingError } from '../payroll-config'
import { runSalaryCalculation } from '../run-calculation'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const COMPANY_ID = '22222222-2222-4222-8222-222222222222'

/** Answers the salary_runs precondition read with one draft run. */
function draftRunClient(paymentDate: string): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({
      data: { id: RUN_ID, company_id: COMPANY_ID, status: 'draft', payment_date: paymentDate },
      error: null,
    }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

function calculate(paymentDate: string) {
  return runSalaryCalculation({
    supabase: draftRunClient(paymentDate),
    companyId: COMPANY_ID,
    salaryRunId: RUN_ID,
    log: createLogger('test/run-calculation-missing-rates'),
    requestId: 'req_test',
  })
}

describe('runSalaryCalculation without the payment year\'s rates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers SALARY_PAYROLL_CONFIG_MISSING with the payment year', async () => {
    vi.mocked(loadPayrollConfig).mockRejectedValue(new PayrollConfigMissingError(2027))
    const result = await calculate('2027-01-25')
    expect(result).toEqual({
      ok: false,
      code: 'SALARY_PAYROLL_CONFIG_MISSING',
      details: { paymentYear: 2027 },
    })
    expect(loadPayrollConfig).toHaveBeenCalledWith(expect.anything(), 2027)
  })

  it('lets any other failure propagate', async () => {
    const dbError = new Error('connection terminated unexpectedly')
    vi.mocked(loadPayrollConfig).mockRejectedValue(dbError)
    await expect(calculate('2026-09-25')).rejects.toBe(dbError)
  })
})
