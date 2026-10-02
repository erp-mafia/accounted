/**
 * Unit tests for lib/salary/employee-soft-delete.ts: the soft delete behind
 * the v1 DELETE /employees/{id} and gnubok_delete_employee. The row is never
 * removed (BFL 7 kap), deactivating an inactive employee writes nothing, a
 * dry run writes nothing, and every query is scoped to the company.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { softDeleteEmployee } from '@/lib/salary/employee-soft-delete'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ACTIVE = { id: EMPLOYEE_ID, first_name: 'Anna', last_name: 'Andersson', is_active: true }
const INACTIVE = { ...ACTIVE, is_active: false }

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

const args = (extra: { dryRun?: boolean } = {}) => ({ companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, ...extra })
const eqFilters = () => mock.findCalls('employees', 'eq')

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('softDeleteEmployee', () => {
  it('sets is_active=false on an active employee, scoped to the company, and never deletes the row', async () => {
    mock.enqueue({ data: ACTIVE })
    mock.enqueue({ data: null })

    const result = await softDeleteEmployee(supabase, args())

    expect(result).toEqual({ ok: true, data: { committed: true, employee: ACTIVE, changed: true } })
    expect(mock.findCalls('employees', 'update')).toEqual([[{ is_active: false }]])
    expect(mock.findCall('employees', 'delete')).toBeUndefined()
    // Both the read and the write filter on company and id.
    expect(eqFilters()).toEqual([
      ['company_id', COMPANY_ID],
      ['id', EMPLOYEE_ID],
      ['company_id', COMPANY_ID],
      ['id', EMPLOYEE_ID],
    ])
  })

  it('writes nothing for an employee who is already inactive (idempotent)', async () => {
    mock.enqueue({ data: INACTIVE })

    const result = await softDeleteEmployee(supabase, args())

    expect(result).toEqual({ ok: true, data: { committed: true, employee: INACTIVE, changed: false } })
    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })

  it('answers EMPLOYEE_NOT_FOUND for an id that is not in the company, without writing', async () => {
    mock.enqueue({ data: null })

    const result = await softDeleteEmployee(supabase, args())

    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })

  it('dry run: returns the employee as read and writes nothing, active or not', async () => {
    mock.enqueue({ data: ACTIVE })
    const active = await softDeleteEmployee(supabase, args({ dryRun: true }))
    expect(active).toEqual({ ok: true, data: { committed: false, employee: ACTIVE } })

    mock.enqueue({ data: INACTIVE })
    const inactive = await softDeleteEmployee(supabase, args({ dryRun: true }))
    expect(inactive).toEqual({ ok: true, data: { committed: false, employee: INACTIVE } })

    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })

  it('dry run: still answers EMPLOYEE_NOT_FOUND', async () => {
    mock.enqueue({ data: null })
    expect(await softDeleteEmployee(supabase, args({ dryRun: true }))).toEqual({
      ok: false,
      code: 'EMPLOYEE_NOT_FOUND',
    })
  })

  it('hands a failed read to the caller as the raw database error, never as not found', async () => {
    const dbError = { code: '57014', message: 'canceling statement due to statement timeout' }
    mock.enqueue({ error: dbError })

    const result = await softDeleteEmployee(supabase, args())

    expect(result).toEqual({ ok: false, code: 'INTERNAL_ERROR', cause: dbError })
    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })

  it('hands a refused update to the caller as the raw database error', async () => {
    const dbError = { code: '23514', message: 'new row violates check constraint "employees_jamkning_dates_check"' }
    mock.enqueue({ data: ACTIVE })
    mock.enqueue({ error: dbError })

    const result = await softDeleteEmployee(supabase, args())

    expect(result).toEqual({ ok: false, code: 'INTERNAL_ERROR', cause: dbError })
  })
})
