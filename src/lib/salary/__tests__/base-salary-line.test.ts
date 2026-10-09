import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { baseSalaryLineType, refreshRunEmployeeSalaryType } from '../base-salary-line'

const ARGS = {
  companyId: 'company-1',
  salaryRunEmployeeId: 'sre-1',
  salaryType: 'hourly',
  employmentType: 'company_owner',
  amount: 4000,
  quantity: 20,
  unitPrice: 200,
}

function callOrder(mock: ReturnType<typeof createQueuedMockSupabase>): string[] {
  const writes = new Set(['select', 'insert', 'delete', 'update'])
  return mock.calls.filter((c) => writes.has(c.method)).map((c) => `${c.table}.${c.method}`)
}

describe('baseSalaryLineType', () => {
  it('maps the pay type to its display line', () => {
    expect(baseSalaryLineType('monthly')).toBe('monthly_salary')
    expect(baseSalaryLineType('hourly')).toBe('hourly_salary')
  })
})

describe('refreshRunEmployeeSalaryType', () => {
  it('inserts the new base line, then deletes the old one, then rewrites the snapshot', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [{ id: 'li-old', item_type: 'monthly_salary' }] }) // base lines read
    mock.enqueue({ data: null }) // new line insert
    mock.enqueue({ data: null }) // old line delete
    mock.enqueue({ data: null }) // snapshot update

    const { error } = await refreshRunEmployeeSalaryType(mock.supabase as unknown as SupabaseClient, ARGS)

    expect(error).toBeNull()
    expect(callOrder(mock)).toEqual([
      'salary_line_items.select',
      'salary_line_items.insert',
      'salary_line_items.delete',
      'salary_run_employees.update',
    ])
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      salary_run_employee_id: 'sre-1',
      item_type: 'hourly_salary',
      description: 'Timlön',
      quantity: 20,
      unit_price: 200,
      amount: 4000,
      account_number: '7220',
    })
    // Only the OTHER base type is deleted: never the line just inserted.
    const inCalls = mock.findCalls('salary_line_items', 'in')
    expect(inCalls.at(-1)).toEqual(['item_type', ['monthly_salary']])
    expect(mock.findCall('salary_run_employees', 'update')).toEqual([{ salary_type: 'hourly' }])
  })

  it('does not insert a second new line when a retry finds one (idempotent after a partial failure)', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [{ id: 'li-new', item_type: 'hourly_salary' }, { id: 'li-old', item_type: 'monthly_salary' }] })
    mock.enqueue({ data: null }) // old line delete
    mock.enqueue({ data: null }) // snapshot update

    const { error } = await refreshRunEmployeeSalaryType(mock.supabase as unknown as SupabaseClient, ARGS)

    expect(error).toBeNull()
    expect(mock.findCalls('salary_line_items', 'insert')).toHaveLength(0)
    expect(callOrder(mock)).toEqual([
      'salary_line_items.select',
      'salary_line_items.delete',
      'salary_run_employees.update',
    ])
  })

  it('keeps the old line and the old snapshot when the insert fails', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [{ id: 'li-old', item_type: 'monthly_salary' }] })
    mock.enqueue({ data: null, error: { message: 'boom' } }) // insert fails

    const { error } = await refreshRunEmployeeSalaryType(mock.supabase as unknown as SupabaseClient, {
      ...ARGS,
      salaryType: 'hourly',
    })

    expect(error).toEqual({ message: 'boom' })
    expect(mock.findCalls('salary_line_items', 'delete')).toHaveLength(0)
    expect(mock.findCalls('salary_run_employees', 'update')).toHaveLength(0)
  })

  it('leaves the snapshot stale (so the next call retries) when the delete fails', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [] })
    mock.enqueue({ data: null }) // insert
    mock.enqueue({ data: null, error: { message: 'boom' } }) // delete fails

    const { error } = await refreshRunEmployeeSalaryType(mock.supabase as unknown as SupabaseClient, ARGS)

    expect(error).toEqual({ message: 'boom' })
    expect(mock.findCalls('salary_run_employees', 'update')).toHaveLength(0)
  })
})
