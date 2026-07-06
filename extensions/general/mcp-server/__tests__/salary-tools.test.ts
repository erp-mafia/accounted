/**
 * Safety tests for the salary MCP tools.
 *
 * After the staging refactor (Phase: ship readiness of the in-app agent),
 * gnubok_create_salary_run and gnubok_generate_agi STAGE a pending_operation
 * instead of writing directly. Approval (and the actual library call) goes
 * through lib/pending-operations/commit.ts: separately covered.
 *
 * gnubok_calculate_salary_run still calls the calculation lib synchronously
 * (no side effects to stage: pure compute against an existing draft run).
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
  it('calls runSalaryCalculation directly: never a self-fetch', async () => {
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
  it('stages without calling generateAgiDeclaration', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // 1. salary_runs lookup → must be past draft
    enqueue({
      data: {
        id: 'run-1', status: 'booked', period_year: 2026, period_month: 3, payment_date: '2026-03-25',
      },
    })
    // 2-3. resolvePeriodStatusForDate calls company_settings + fiscal_periods
    enqueue({ data: null })
    enqueue({ data: null })
    // 4. pending_operations.insert
    enqueue({ data: { id: 'op-1' }, error: null })

    const result = (await generateAgi.execute(
      { salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
    )) as { staged: boolean; risk_level: string; operation_id?: string }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(mockGenerateAgi).not.toHaveBeenCalled()
  })

  it('throws when the run is still in draft', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'run-1', status: 'draft', period_year: 2026, period_month: 3, payment_date: '2026-03-25' },
    })
    await expect(
      generateAgi.execute({ salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'agent_chat' }),
    ).rejects.toThrow(/past draft/)
  })
})

describe('gnubok_create_salary_run', () => {
  it('stages without calling the transactional helper', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // 1. employees count head
    enqueue({ data: null, count: 3 })
    // 2-3. resolvePeriodStatusForDate calls company_settings + fiscal_periods
    enqueue({ data: null })
    enqueue({ data: null })
    // 4. pending_operations.insert
    enqueue({ data: { id: 'op-2' }, error: null })

    const result = (await createSalaryRun.execute(
      { period_year: 2026, period_month: 3, payment_date: '2026-03-25' },
      'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
    )) as { staged: boolean; risk_level: string; preview: { period: string; employee_count: number } }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.period).toBe('2026-03')
    expect(result.preview.employee_count).toBe(3)
    expect(mockCreateRun).not.toHaveBeenCalled()
  })

  it('rejects an invalid period_month', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createSalaryRun.execute(
        { period_year: 2026, period_month: 0, payment_date: '2026-03-25' },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/period_month must be 1-12/)
  })
})
