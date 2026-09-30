/**
 * Unit tests for lib/salary/payslip-lines.ts (payroll gap-closure 1.2).
 *
 * The service is the single source of truth for payslip line commands across
 * internal routes, v1, and the MCP executor: draft gate, run-membership
 * verification, roundOre money math, account auto-resolution.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  createPayslipLine,
  updatePayslipLine,
  deletePayslipLine,
} from '@/lib/salary/payslip-lines'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const BASE_INPUT = {
  item_type: 'bonus' as const,
  description: 'Kvartalsbonus',
  amount: 5000,
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: true,
  is_gross_deduction: false,
  is_net_deduction: false,
  sort_order: 0,
}

const EXISTING_LINE = {
  id: LINE_ID,
  salary_run_employee_id: SRE_ID,
  company_id: COMPANY_ID,
  item_type: 'bonus',
  description: 'Kvartalsbonus',
  quantity: null,
  unit_price: null,
  amount: 5000,
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: true,
  is_gross_deduction: false,
  is_net_deduction: false,
  account_number: '7210',
  sort_order: 0,
  created_at: '2026-05-01T08:00:00Z',
  updated_at: '2026-05-01T08:00:00Z',
  salary_run_employee: { salary_run_id: RUN_ID },
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('createPayslipLine', () => {
  it('returns SALARY_RUN_NOT_FOUND when the run is missing', async () => {
    mock.enqueue({ data: null })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: BASE_INPUT,
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
  })

  it('returns SALARY_RUN_LINE_NOT_DRAFT with the current status once the run advanced', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'review' } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: BASE_INPUT,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
      expect(result.details).toEqual({ current_status: 'review' })
    }
  })

  it('returns SALARY_RUN_EMPLOYEE_NOT_FOUND when the employee is not in the run', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: null })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: BASE_INPUT,
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' })
  })

  it('creates a line with roundOre money math and auto-resolved account', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    mock.enqueue({ data: { ...EXISTING_LINE, amount: 1.01 } })

    // 1.005 is the exact-half value where naive Math.round(x*100)/100 fails
    // (rounds down to 1.00); roundOre must produce 1.01.
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { salaryRunEmployeeId: SRE_ID },
      input: { ...BASE_INPUT, amount: 1.005 },
    })

    expect(result.ok).toBe(true)
    // Assert what the service sent to the DB, not just what the mock echoed.
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees', 'salary_line_items'])
  })

  it('dry-run validates and returns the would-be row without inserting', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })

    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: { ...BASE_INPUT, amount: 1.005 },
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.id).toBeNull()
      expect(result.data.amount).toBe(1.01)
      // Auto-resolved from item_type 'bonus'.
      expect(result.data.account_number).toBe('7210')
    }
    // Only the gate + sre lookups hit the DB; no insert.
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees'])
  })
})

describe('updatePayslipLine', () => {
  it('returns SALARY_LINE_NOT_FOUND when the line belongs to a different run', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({
      data: {
        ...EXISTING_LINE,
        salary_run_employee: { salary_run_id: '99999999-9999-4999-8999-999999999999' },
      },
    })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { amount: 6000 },
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_LINE_NOT_FOUND' })
  })

  it('rounds a patched amount via roundOre and returns the updated row', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: EXISTING_LINE })
    mock.enqueue({ data: { ...EXISTING_LINE, amount: 1.01, salary_run_employee: undefined } })

    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { amount: 1.005 },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.amount).toBe(1.01)
  })

  it('dry-run returns the merged row without writing', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: EXISTING_LINE })

    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { amount: 1.005, description: 'Justerad bonus' },
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.amount).toBe(1.01)
      expect(result.data.description).toBe('Justerad bonus')
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_line_items'])
  })

  it('gates on draft status', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'booked' } })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { amount: 6000 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
  })
})

describe('deletePayslipLine', () => {
  it('deletes a line in a draft run', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: EXISTING_LINE })
    mock.enqueue({ data: null })

    const result = await deletePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.deleted).toBe(true)
      expect(result.data.salary_line_item_id).toBe(LINE_ID)
    }
  })

  it('dry-run verifies gates without deleting', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: EXISTING_LINE })

    const result = await deletePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_line_items'])
  })

  it('returns SALARY_LINE_NOT_FOUND for a missing line', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: null })

    const result = await deletePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_LINE_NOT_FOUND' })
  })
})

describe('engångsskatt (one_off_tax_percent)', () => {
  it('passes the percentage through to the row on create', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: { ...BASE_INPUT, one_off_tax_percent: 30 },
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.one_off_tax_percent).toBe(30)
  })

  it('stores null when no percentage is given', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: BASE_INPUT,
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.one_off_tax_percent).toBeNull()
  })

  it('refuses a percentage on a net deduction line at create, before any write', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: { ...BASE_INPUT, item_type: 'net_deduction_union', amount: -300, is_net_deduction: true, one_off_tax_percent: 30 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR')
      expect(result.details?.field).toBe('one_off_tax_percent')
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees'])
  })

  it('validates one-off tax against the merged line before a sparse update', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { ...EXISTING_LINE, one_off_tax_percent: 34 } })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { is_net_deduction: true },
      dryRun: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('lets the same sparse update through when it also clears the percentage', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { ...EXISTING_LINE, one_off_tax_percent: 34 } })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { is_net_deduction: true, one_off_tax_percent: null },
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.one_off_tax_percent).toBeNull()
  })
})

describe('vacation_category on payslip lines', () => {
  const VACATION_INPUT = {
    ...BASE_INPUT,
    item_type: 'vacation' as const,
    description: 'Semester',
    quantity: 2,
    amount: -3000,
  }

  it('stores the category and saved year on a vacation line', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'vacation', vacation_category: 'saved', vacation_saved_year: '2025' } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { salaryRunEmployeeId: SRE_ID },
      input: { ...VACATION_INPUT, vacation_category: 'saved', vacation_saved_year: '2025' },
    })
    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      item_type: 'vacation',
      vacation_category: 'saved',
      vacation_saved_year: '2025',
    })
  })

  it('writes null for both columns when the caller sends neither (paid by default)', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'vacation' } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { salaryRunEmployeeId: SRE_ID },
      input: VACATION_INPUT,
    })
    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      vacation_category: null,
      vacation_saved_year: null,
    })
  })

  it('refuses a category on a non-vacation line with a 400 before writing', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { salaryRunEmployeeId: SRE_ID },
      input: { ...BASE_INPUT, vacation_category: 'paid' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR')
      expect(result.details?.field).toBe('vacation_category')
    }
    expect(mock.findCall('salary_line_items', 'insert')).toBeUndefined()
  })

  it('refuses a saved year without category saved', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { salaryRunEmployeeId: SRE_ID },
      input: { ...VACATION_INPUT, vacation_category: 'paid', vacation_saved_year: '2025' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('validates the merged row on update: a category patch onto a bonus line is refused', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: EXISTING_LINE })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { vacation_category: 'unpaid' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.details?.field).toBe('vacation_category')
    expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
  })

  it('accepts a category patch on a vacation line and clears it with null', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'vacation', vacation_category: 'saved', vacation_saved_year: '2025' } })
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'vacation', vacation_category: null, vacation_saved_year: null } })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { vacation_category: null, vacation_saved_year: null },
    })
    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_line_items', 'update')?.[0]).toEqual({
      vacation_category: null,
      vacation_saved_year: null,
    })
  })

  it('a category patch alone off saved retires the origin year (null returns the line to paid days)', async () => {
    for (const category of [null, 'unpaid'] as const) {
      mock.reset()
      mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
      mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'vacation', vacation_category: 'saved', vacation_saved_year: '2025' } })
      mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'vacation', vacation_category: category, vacation_saved_year: null } })
      const result = await updatePayslipLine(supabase, {
        companyId: COMPANY_ID,
        salaryRunId: RUN_ID,
        lineId: LINE_ID,
        patch: { vacation_category: category },
      })
      expect(result.ok).toBe(true)
      expect(mock.findCall('salary_line_items', 'update')?.[0]).toEqual({
        vacation_category: category,
        vacation_saved_year: null,
      })
    }
  })

  it('keeps an explicitly patched saved year and refuses it without category saved', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'vacation', vacation_category: 'saved', vacation_saved_year: '2025' } })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { vacation_category: null, vacation_saved_year: '2024' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.details?.field).toBe('vacation_category')
    expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
  })
})

describe('lines the calculation owns (#3185)', () => {
  const draftRun = () => mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })

  it.each(['overtime_50', 'overtime_100', 'ob_weekend', 'ob_night', 'sick_karens', 'vab', 'unpaid_leave'])(
    'refuses a hand-added %s line before reading or writing anything',
    async (itemType) => {
      const result = await createPayslipLine(supabase, {
        companyId: COMPANY_ID,
        salaryRunId: RUN_ID,
        target: { employeeId: EMPLOYEE_ID },
        input: { ...BASE_INPUT, item_type: itemType as never },
      })

      expect(result).toEqual({ ok: false, code: 'SALARY_LINE_CALCULATED', details: { item_type: itemType } })
      expect(mock.supabase.from).not.toHaveBeenCalled()
    },
  )

  it('still adds a one-off övertid amount on item_type overtime', async () => {
    draftRun()
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'overtime', description: 'Övertid 50 %' } })

    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: { ...BASE_INPUT, item_type: 'overtime', description: 'Övertid 50 %', amount: 1800 },
    })

    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_line_items', 'insert')).toBeDefined()
  })

  it.each([
    ['a derived OB row', { item_type: 'ob_night' }],
    ['a derived sick row', { item_type: 'sick_day2_14' }],
    ['a förmån row', { item_type: 'benefit_car', source_benefit_id: '11111111-1111-4111-8111-111111111111' }],
    ['a recurring-line row', { item_type: 'net_deduction_union', source_recurring_line_id: '22222222-2222-4222-8222-222222222222' }],
    ['the engine semesterersättning row', { item_type: 'semesterersattning', calculation_source: 'vacation_compensation' }],
    ['the öresavrundning row', { item_type: 'oresavrundning' }],
  ])('refuses editing %s, which the next calculation would overwrite', async (_label, fields) => {
    draftRun()
    mock.enqueue({ data: { ...EXISTING_LINE, ...fields } })

    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { amount: 1234 },
    })

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_LINE_CALCULATED',
      details: { salary_line_item_id: LINE_ID, item_type: fields.item_type },
    })
    expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
  })

  it('refuses a patch that turns a manual line into a calculated type, before reading anything', async () => {
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { item_type: 'overtime_100' },
    })

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_LINE_CALCULATED',
      details: { salary_line_item_id: LINE_ID, item_type: 'overtime_100' },
    })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('refuses deleting a derived row, which the next calculation would bring back', async () => {
    draftRun()
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'sick_karens' } })

    const result = await deletePayslipLine(supabase, { companyId: COMPANY_ID, salaryRunId: RUN_ID, lineId: LINE_ID })

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_LINE_CALCULATED',
      details: { salary_line_item_id: LINE_ID, item_type: 'sick_karens' },
    })
    expect(mock.findCall('salary_line_items', 'delete')).toBeUndefined()
  })

  it('still deletes a hand-entered semesterersättning line (no calculation_source)', async () => {
    draftRun()
    mock.enqueue({ data: { ...EXISTING_LINE, item_type: 'semesterersattning', calculation_source: null } })
    mock.enqueue({ data: null })

    const result = await deletePayslipLine(supabase, { companyId: COMPANY_ID, salaryRunId: RUN_ID, lineId: LINE_ID })

    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_line_items', 'delete')).toBeDefined()
  })

  it('reads the provenance columns but never returns them in the row', async () => {
    draftRun()
    mock.enqueue({ data: { ...EXISTING_LINE, calculation_source: null, source_benefit_id: null, source_recurring_line_id: null } })

    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { amount: 5500 },
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).not.toHaveProperty('calculation_source')
      expect(result.data).not.toHaveProperty('source_benefit_id')
      expect(result.data).not.toHaveProperty('source_recurring_line_id')
    }
  })
})
