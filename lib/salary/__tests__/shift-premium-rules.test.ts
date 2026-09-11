/**
 * Service-level tests for lib/salary/shift-premium-rules.ts: row
 * normalisation (TIME and NUMERIC shapes over PostgREST), the company check
 * on named employees, and the merged-state scope rule on update.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createShiftPremiumRule,
  deleteShiftPremiumRule,
  findForeignEmployeeIds,
  listShiftPremiumRules,
  toClockTime,
  updateShiftPremiumRule,
} from '../shift-premium-rules'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const EMP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const stored = {
  id: 'rule-1',
  company_id: 'company-1',
  name: 'OB helg',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  day_of_week: [7, 6],
  start_time: '00:00:00',
  end_time: '23:59:00',
  premium_percent: '100.00',
  item_type: 'ob_weekend',
  priority: 5,
  is_active: true,
  created_at: '2026-09-11T08:00:00Z',
  updated_at: '2026-09-11T08:00:00Z',
  created_by: 'user-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('toClockTime', () => {
  it('drops seconds from Postgres TIME and passes HH:MM through', () => {
    expect(toClockTime('22:00:00')).toBe('22:00')
    expect(toClockTime('06:30')).toBe('06:30')
  })
})

describe('listShiftPremiumRules', () => {
  it('normalises times, percent and weekday order', async () => {
    enqueue({ data: [stored] })
    const result = await listShiftPremiumRules(client, { companyId: 'company-1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0]).toMatchObject({
      start_time: '00:00',
      end_time: '23:59',
      premium_percent: 100,
      day_of_week: [6, 7],
    })
    // Active-only by default: the same set the engine loads.
    const eqArgs = supabase.from.mock.calls.length
    expect(eqArgs).toBe(1)
    expect(findCall('shift_premium_rules', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('maps a database error to INTERNAL_ERROR', async () => {
    enqueue({ error: { message: 'boom' } })
    const result = await listShiftPremiumRules(client, { companyId: 'company-1' })
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
  })
})

describe('findForeignEmployeeIds', () => {
  it('skips the lookup for an empty list', async () => {
    const result = await findForeignEmployeeIds(client, 'company-1', [])
    expect(result).toEqual({ ok: true, data: [] })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns the ids the company does not own', async () => {
    enqueue({ data: [{ id: EMP_A }] })
    const result = await findForeignEmployeeIds(client, 'company-1', [EMP_A, EMP_B])
    expect(result).toEqual({ ok: true, data: [EMP_B] })
    expect(findCall('employees', 'in')).toEqual(['id', [EMP_A, EMP_B]])
  })
})

describe('createShiftPremiumRule', () => {
  const input = {
    name: 'OB helg',
    day_of_week: [7, 6],
    start_time: '00:00',
    end_time: '23:59',
    premium_percent: 100,
    item_type: 'ob_weekend' as const,
    priority: 5,
    applies_to_all_employees: false,
    applies_to_employee_ids: [EMP_A],
    is_active: true,
  }

  it('refuses a foreign employee before inserting', async () => {
    enqueue({ data: [] }) // employees: none found
    const result = await createShiftPremiumRule(client, { companyId: 'company-1', userId: 'u', input })
    expect(result).toMatchObject({
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND',
      details: { missing_employee_ids: [EMP_A] },
    })
    expect(findCall('shift_premium_rules', 'insert')).toBeUndefined()
  })

  it('inserts with sorted weekdays and the creator', async () => {
    enqueue({ data: [{ id: EMP_A }] })
    enqueue({ data: { ...stored, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] } })
    const result = await createShiftPremiumRule(client, { companyId: 'company-1', userId: 'u', input })
    expect(result.ok).toBe(true)
    const inserted = findCall('shift_premium_rules', 'insert')?.[0] as Record<string, unknown>
    expect(inserted.day_of_week).toEqual([6, 7])
    expect(inserted.created_by).toBe('u')
    expect(inserted.company_id).toBe('company-1')
  })

  it('maps a CHECK violation to VALIDATION_ERROR', async () => {
    enqueue({ data: [{ id: EMP_A }] })
    enqueue({ error: { code: '23514', message: 'check' } })
    const result = await createShiftPremiumRule(client, { companyId: 'company-1', userId: 'u', input })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('updateShiftPremiumRule', () => {
  it('returns not found when the rule is missing', async () => {
    enqueue({ data: null })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-x',
      input: { name: 'x' },
    })
    expect(result).toMatchObject({ ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' })
  })

  it('checks scope on the merged state', async () => {
    enqueue({ data: stored })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-1',
      input: { applies_to_all_employees: false },
    })
    expect(result).toMatchObject({ ok: false, code: 'SHIFT_PREMIUM_RULE_SCOPE_INVALID' })
    expect(findCall('shift_premium_rules', 'update')).toBeUndefined()
  })

  it('accepts a scope narrowing when the ids are supplied and owned', async () => {
    enqueue({ data: stored })
    enqueue({ data: [{ id: EMP_A }] })
    enqueue({ data: { ...stored, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] } })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-1',
      input: { applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] },
    })
    expect(result.ok).toBe(true)
    expect(findCall('shift_premium_rules', 'update')?.[0]).toEqual({
      applies_to_all_employees: false,
      applies_to_employee_ids: [EMP_A],
    })
  })
})

describe('deleteShiftPremiumRule', () => {
  it('reports an unknown id instead of a silent no-op', async () => {
    enqueue({ data: [] })
    const result = await deleteShiftPremiumRule(client, { companyId: 'company-1', ruleId: 'rule-x' })
    expect(result).toMatchObject({ ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' })
  })

  it('deletes within the company', async () => {
    enqueue({ data: [{ id: 'rule-1' }] })
    const result = await deleteShiftPremiumRule(client, { companyId: 'company-1', ruleId: 'rule-1' })
    expect(result).toEqual({ ok: true, data: { id: 'rule-1', deleted: true } })
    expect(findCall('shift_premium_rules', 'eq')).toEqual(['company_id', 'company-1'])
  })
})
