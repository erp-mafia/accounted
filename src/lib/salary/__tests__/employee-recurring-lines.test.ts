/**
 * Unit tests for lib/salary/employee-recurring-lines.ts (payroll gap-closure 5).
 *
 * Employee ownership gate, the input rules that mirror the table CHECKs
 * (amount sign per item type, merged validity period, account format),
 * öre rounding, dry-run previews that never write, and the delete-or-
 * deactivate outcome driven by the salary_line_items FK.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { RECURRING_LINE_PERIOD_ORDER_MESSAGE } from '@/lib/api/schemas'
import { RECURRING_LINE_AMOUNT_SIGN_MESSAGE } from '@/lib/salary/recurring-lines'
import {
  createEmployeeRecurringLine,
  deleteEmployeeRecurringLine,
  listEmployeeRecurringLines,
  updateEmployeeRecurringLine,
  type EmployeeRecurringLineRow,
} from '@/lib/salary/employee-recurring-lines'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const STORED: EmployeeRecurringLineRow = {
  id: LINE_ID,
  employee_id: EMPLOYEE_ID,
  company_id: COMPANY_ID,
  user_id: USER_ID,
  item_type: 'gross_deduction_other',
  description: 'Förmånscykel bruttolöneavdrag',
  amount: -670.17,
  account_number: null,
  valid_from: '2026-01-01',
  valid_to: null,
  metadata: {},
  is_active: true,
  created_at: '2026-01-01T08:00:00Z',
  updated_at: '2026-01-01T08:00:00Z',
}

const validInput = {
  item_type: 'gross_deduction_other' as const,
  description: 'Förmånscykel bruttolöneavdrag',
  amount: -670.17,
  valid_from: '2026-01-01',
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('listEmployeeRecurringLines', () => {
  it('returns EMPLOYEE_NOT_FOUND for an employee outside the company', async () => {
    mock.enqueue({ data: null })
    const result = await listEmployeeRecurringLines(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(mock.findCall('employee_recurring_lines', 'select')).toBeUndefined()
  })

  it('reports an employee-lookup failure as INTERNAL_ERROR, not as missing', async () => {
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    const result = await listEmployeeRecurringLines(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })

  it('lists every line, scoped by company, when no active filter is given', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [STORED] })
    const result = await listEmployeeRecurringLines(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result).toEqual({ ok: true, data: [STORED] })
    const eqs = mock.findCalls('employee_recurring_lines', 'eq')
    expect(eqs).toContainEqual(['company_id', COMPANY_ID])
    expect(eqs).toContainEqual(['employee_id', EMPLOYEE_ID])
    expect(eqs.some(([col]) => col === 'is_active')).toBe(false)
  })

  it('applies the is_active filter when asked', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [] })
    await listEmployeeRecurringLines(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      isActive: false,
    })
    expect(mock.findCalls('employee_recurring_lines', 'eq')).toContainEqual(['is_active', false])
  })
})

describe('createEmployeeRecurringLine', () => {
  it('rejects a non-negative amount before touching the database', async () => {
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: { ...validInput, amount: 670.17 },
    })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { issues: [{ field: 'amount', message: RECURRING_LINE_AMOUNT_SIGN_MESSAGE }] },
    })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('rejects valid_to before valid_from with the shared period copy', async () => {
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: { ...validInput, valid_from: '2026-06-01', valid_to: '2026-05-31' },
    })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { issues: [{ field: 'valid_to', message: RECURRING_LINE_PERIOD_ORDER_MESSAGE }] },
    })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an account_number that is not four digits', async () => {
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: { ...validInput, account_number: '73990' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR')
      expect(result.details?.issues).toEqual([
        expect.objectContaining({ field: 'account_number' }),
      ])
    }
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('returns EMPLOYEE_NOT_FOUND for an employee outside the company', async () => {
    mock.enqueue({ data: null })
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: validInput,
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(mock.findCall('employee_recurring_lines', 'insert')).toBeUndefined()
  })

  it('inserts the row with tenancy columns, öre rounding and defaults (happy path)', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: STORED })
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: { ...validInput, amount: -670.166 },
    })
    expect(result).toEqual({ ok: true, data: STORED })
    const insert = mock.findCall('employee_recurring_lines', 'insert')
    expect(insert?.[0]).toEqual({
      employee_id: EMPLOYEE_ID,
      company_id: COMPANY_ID,
      user_id: USER_ID,
      item_type: 'gross_deduction_other',
      description: 'Förmånscykel bruttolöneavdrag',
      amount: -670.17,
      account_number: null,
      valid_from: '2026-01-01',
      valid_to: null,
      metadata: {},
      is_active: true,
    })
  })

  it('returns the would-be row on dry run without inserting', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: { ...validInput, valid_to: '2026-12-31', account_number: '7399' },
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.id).toBeNull()
      expect(result.data.valid_to).toBe('2026-12-31')
      expect(result.data.account_number).toBe('7399')
    }
    expect(mock.findCall('employee_recurring_lines', 'insert')).toBeUndefined()
  })

  it('maps a check_violation on insert to VALIDATION_ERROR and keeps the cause', async () => {
    const pgError = { code: '23514', message: 'violates check constraint' }
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: pgError })
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: validInput,
    })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { pg_code: '23514' },
      cause: pgError,
    })
  })

  it('maps an RLS denial on insert to DB_PERMISSION_DENIED', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: validInput,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('DB_PERMISSION_DENIED')
  })

  it('reports any other insert failure as INTERNAL_ERROR', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    const result = await createEmployeeRecurringLine(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: validInput,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })
})

describe('updateEmployeeRecurringLine', () => {
  const base = { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, lineId: LINE_ID }

  it('returns NOT_FOUND when the line is not under this employee and company', async () => {
    mock.enqueue({ data: null })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: { amount: -700 } })
    expect(result).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      details: { resource: 'employee_recurring_line', employee_recurring_line_id: LINE_ID },
    })
    const eqs = mock.findCalls('employee_recurring_lines', 'eq')
    expect(eqs).toContainEqual(['company_id', COMPANY_ID])
    expect(eqs).toContainEqual(['employee_id', EMPLOYEE_ID])
  })

  it('treats a PGRST116 on the fetch as NOT_FOUND', async () => {
    mock.enqueue({ data: null, error: { code: 'PGRST116', message: 'zero rows' } })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: { amount: -700 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FOUND')
  })

  it('reports a transport failure on the fetch as INTERNAL_ERROR, not NOT_FOUND', async () => {
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: { amount: -700 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })

  it('rejects an amount whose sign contradicts the stored item_type', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: { amount: 700 } })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { issues: [{ field: 'amount', message: RECURRING_LINE_AMOUNT_SIGN_MESSAGE }] },
    })
    expect(mock.findCall('employee_recurring_lines', 'update')).toBeUndefined()
  })

  it('rejects a patched valid_to that lands before the STORED valid_from', async () => {
    mock.enqueue({ data: { ...STORED, valid_from: '2026-06-01' } })
    const result = await updateEmployeeRecurringLine(supabase, {
      ...base,
      patch: { valid_to: '2026-05-31' },
    })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { issues: [{ field: 'valid_to', message: RECURRING_LINE_PERIOD_ORDER_MESSAGE }] },
    })
  })

  it('rejects a patched valid_from that lands after the STORED valid_to', async () => {
    mock.enqueue({ data: { ...STORED, valid_to: '2026-03-31' } })
    const result = await updateEmployeeRecurringLine(supabase, {
      ...base,
      patch: { valid_from: '2026-04-01' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('accepts clearing valid_to (null) on a row whose valid_from is set', async () => {
    mock.enqueue({ data: { ...STORED, valid_to: '2026-03-31' } })
    mock.enqueue({ data: { ...STORED, valid_to: null } })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: { valid_to: null } })
    expect(result.ok).toBe(true)
    expect(mock.findCall('employee_recurring_lines', 'update')?.[0]).toEqual({ valid_to: null })
  })

  it('writes exactly the patchable columns, with the amount rounded to öre', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: STORED })
    await updateEmployeeRecurringLine(supabase, {
      ...base,
      patch: {
        description: 'Förmånscykel',
        amount: -700.004,
        account_number: '7399',
        valid_from: '2026-02-01',
        valid_to: '2026-12-31',
        metadata: { source: 'test' },
        is_active: false,
      },
    })
    const update = mock.findCall('employee_recurring_lines', 'update')?.[0] as Record<string, unknown>
    expect(Object.keys(update).sort()).toEqual([
      'account_number',
      'amount',
      'description',
      'is_active',
      'metadata',
      'valid_from',
      'valid_to',
    ])
    expect(update.amount).toBe(-700)
  })

  it('returns the stored row without writing when the patch is empty', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: {} })
    expect(result).toEqual({ ok: true, data: STORED })
    expect(mock.findCall('employee_recurring_lines', 'update')).toBeUndefined()
  })

  it('returns the merged row on dry run without writing', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeRecurringLine(supabase, {
      ...base,
      patch: { amount: -700, valid_to: '2026-12-31' },
      dryRun: true,
    })
    expect(result).toEqual({ ok: true, data: { ...STORED, amount: -700, valid_to: '2026-12-31' } })
    expect(mock.findCall('employee_recurring_lines', 'update')).toBeUndefined()
  })

  it('maps a PGRST116 on the write to NOT_FOUND (row vanished between fetch and update)', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: null, error: { code: 'PGRST116', message: 'zero rows' } })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: { amount: -700 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FOUND')
  })

  it('maps a check_violation on the write to the period VALIDATION_ERROR', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: null, error: { code: '23514', message: 'violates check constraint' } })
    const result = await updateEmployeeRecurringLine(supabase, {
      ...base,
      patch: { valid_from: '2026-02-01' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR')
      expect(result.details?.issues).toEqual([
        { field: 'valid_to', message: RECURRING_LINE_PERIOD_ORDER_MESSAGE },
      ])
    }
  })

  it('returns the updated row (happy path)', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: { ...STORED, amount: -700 } })
    const result = await updateEmployeeRecurringLine(supabase, { ...base, patch: { amount: -700 } })
    expect(result).toEqual({ ok: true, data: { ...STORED, amount: -700 } })
  })
})

describe('deleteEmployeeRecurringLine', () => {
  const base = { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, lineId: LINE_ID }

  it('hard-deletes a line no run has derived from', async () => {
    mock.enqueue({ data: { id: LINE_ID } })
    const result = await deleteEmployeeRecurringLine(supabase, base)
    expect(result).toEqual({ ok: true, data: { id: LINE_ID, deleted: true } })
    const eqs = mock.findCalls('employee_recurring_lines', 'eq')
    expect(eqs).toContainEqual(['company_id', COMPANY_ID])
    expect(eqs).toContainEqual(['employee_id', EMPLOYEE_ID])
  })

  it('returns NOT_FOUND when the filtered delete matches nothing', async () => {
    mock.enqueue({ data: null })
    const result = await deleteEmployeeRecurringLine(supabase, base)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FOUND')
  })

  it('deactivates instead of deleting when the FK refuses (23503)', async () => {
    mock.enqueue({ error: { code: '23503', message: 'violates foreign key constraint' } })
    mock.enqueue({ data: null })
    const result = await deleteEmployeeRecurringLine(supabase, base)
    expect(result).toEqual({ ok: true, data: { id: LINE_ID, deleted: false, deactivated: true } })
    expect(mock.findCall('employee_recurring_lines', 'update')?.[0]).toEqual({ is_active: false })
  })

  it('reports a failed deactivation as INTERNAL_ERROR', async () => {
    mock.enqueue({ error: { code: '23503', message: 'violates foreign key constraint' } })
    mock.enqueue({ error: { code: '08006', message: 'connection failure' } })
    const result = await deleteEmployeeRecurringLine(supabase, base)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })

  it('reports any other delete failure as INTERNAL_ERROR without deactivating', async () => {
    mock.enqueue({ error: { code: '08006', message: 'connection failure' } })
    const result = await deleteEmployeeRecurringLine(supabase, base)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
    expect(mock.findCall('employee_recurring_lines', 'update')).toBeUndefined()
  })

  describe('dry run', () => {
    it('previews a hard delete when nothing references the line', async () => {
      mock.enqueue({ data: { id: LINE_ID } }) // existence
      mock.enqueue({ data: null, count: 0 }) // derived rows
      const result = await deleteEmployeeRecurringLine(supabase, { ...base, dryRun: true })
      expect(result).toEqual({ ok: true, data: { id: LINE_ID, deleted: true } })
      expect(mock.findCall('employee_recurring_lines', 'delete')).toBeUndefined()
      expect(mock.findCall('employee_recurring_lines', 'update')).toBeUndefined()
    })

    it('previews a deactivation when a run has derived from the line', async () => {
      mock.enqueue({ data: { id: LINE_ID } })
      mock.enqueue({ data: null, count: 2 })
      const result = await deleteEmployeeRecurringLine(supabase, { ...base, dryRun: true })
      expect(result).toEqual({ ok: true, data: { id: LINE_ID, deleted: false, deactivated: true } })
      expect(mock.findCalls('salary_line_items', 'eq')).toContainEqual([
        'source_recurring_line_id',
        LINE_ID,
      ])
      expect(mock.findCall('employee_recurring_lines', 'delete')).toBeUndefined()
    })

    it('returns NOT_FOUND for an unknown line', async () => {
      mock.enqueue({ data: null })
      const result = await deleteEmployeeRecurringLine(supabase, { ...base, dryRun: true })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('NOT_FOUND')
    })
  })
})
