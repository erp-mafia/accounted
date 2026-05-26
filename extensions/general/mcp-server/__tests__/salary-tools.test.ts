/**
 * Safety tests for the salary MCP tools after de-risking (P0-2):
 *   - calculate_salary_run calls the extracted lib directly (no self-fetch / forged cookie)
 *   - generate_agi actually generates + persists the declaration (not a no-op URL)
 *   - create_salary_run delegates to the transactional helper
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockRunSalaryCalculation = vi.fn()
vi.mock('@/lib/salary/run-calculation', () => ({
  runSalaryCalculation: (...a: unknown[]) => mockRunSalaryCalculation(...a),
}))

const mockGenerateAgi = vi.fn()
vi.mock('@/lib/salary/agi/generate-declaration', () => ({
  generateAgiDeclaration: (...a: unknown[]) => mockGenerateAgi(...a),
}))

const mockCreateRun = vi.fn()
vi.mock('@/lib/salary/create-run', () => ({
  createSalaryRunWithEmployees: (...a: unknown[]) => mockCreateRun(...a),
}))

import { tools } from '../server'

const createSalaryRun = tools.find((t) => t.name === 'gnubok_create_salary_run')!
const calculateSalaryRun = tools.find((t) => t.name === 'gnubok_calculate_salary_run')!
const generateAgi = tools.find((t) => t.name === 'gnubok_generate_agi')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_calculate_salary_run', () => {
  it('calls runSalaryCalculation directly — never a self-fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    mockRunSalaryCalculation.mockResolvedValue({ ok: true, run: { status: 'draft' }, warnings: ['w1'] })
    const { supabase } = createQueuedMockSupabase()

    const result = (await calculateSalaryRun.execute(
      { salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { salary_run_id: string; status: string; warnings: string[]; next: { tool: string } }

    expect(result.salary_run_id).toBe('run-1')
    expect(result.warnings).toEqual(['w1'])
    expect(result.next.tool).toBe('gnubok_get_salary_run')
    expect(mockRunSalaryCalculation).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', salaryRunId: 'run-1' }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('throws when the calculation lib returns not-ok', async () => {
    mockRunSalaryCalculation.mockResolvedValue({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    const { supabase } = createQueuedMockSupabase()
    await expect(
      calculateSalaryRun.execute({ salary_run_id: 'run-x' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/SALARY_RUN_NOT_FOUND/)
  })
})

describe('gnubok_generate_agi', () => {
  it('generates + persists the declaration and surfaces agi_declaration_id', async () => {
    mockGenerateAgi.mockResolvedValue({
      ok: true, xml: '<x/>', agiDeclarationId: 'agi-1', periodYear: 2026, periodMonth: 3,
      employeeCount: 2, isCorrection: false, totals: {}, orgNumber: '5566778899',
    })
    const { supabase } = createQueuedMockSupabase()
    const result = (await generateAgi.execute(
      { salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { agi_declaration_id: string; period: string; employee_count: number }

    expect(result.agi_declaration_id).toBe('agi-1')
    expect(result.period).toBe('2026-03')
    expect(result.employee_count).toBe(2)
    expect(mockGenerateAgi).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1', salaryRunId: 'run-1' }),
    )
  })

  it('throws when the run is not eligible (past draft)', async () => {
    mockGenerateAgi.mockResolvedValue({ ok: false, code: 'AGI_GENERATE_NOT_BOOKABLE' })
    const { supabase } = createQueuedMockSupabase()
    await expect(
      generateAgi.execute({ salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/AGI_GENERATE_NOT_BOOKABLE/)
  })
})

describe('gnubok_create_salary_run', () => {
  it('delegates to the transactional helper and returns a next hint', async () => {
    mockCreateRun.mockResolvedValue({ run: { id: 'run-9', status: 'draft' }, employeeCount: 3 })
    const { supabase } = createQueuedMockSupabase()
    const result = (await createSalaryRun.execute(
      { period_year: 2026, period_month: 3, payment_date: '2026-03-25' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { id: string; employee_count: number; next: { tool: string } }

    expect(result.id).toBe('run-9')
    expect(result.employee_count).toBe(3)
    expect(result.next.tool).toBe('gnubok_calculate_salary_run')
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1',
      { periodYear: 2026, periodMonth: 3, paymentDate: '2026-03-25' },
    )
  })
})
