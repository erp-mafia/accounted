/**
 * Service-level tests for lib/salary/shift-premium-rules.ts: row
 * normalisation (TIME and NUMERIC shapes over PostgREST), the company and
 * pay-form checks on named employees, the merged-state rules on update
 * (scope, amount form, validity) and the delete that becomes a deactivation
 * once a payslip line derives from the rule.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CreateShiftPremiumRuleSchema, UpdateShiftPremiumRuleSchema } from '@/lib/api/schemas'
import {
  checkNamedEmployees,
  createShiftPremiumRule,
  deleteShiftPremiumRule,
  listShiftPremiumRules,
  toClockTime,
  updateShiftPremiumRule,
} from '../shift-premium-rules'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

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
  amount_form: 'percent_of_hourly',
  premium_percent: '100.00',
  monthly_divisor: null,
  sek_per_hour: null,
  hourly_divisor: '166.00',
  valid_from: '2026-04-01',
  valid_to: null,
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
  it('normalises times, numerics and weekday order', async () => {
    enqueue({ data: [stored] })
    const result = await listShiftPremiumRules(client, { companyId: 'company-1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0]).toMatchObject({
      start_time: '00:00',
      end_time: '23:59',
      amount_form: 'percent_of_hourly',
      premium_percent: 100,
      hourly_divisor: 166,
      monthly_divisor: null,
      sek_per_hour: null,
      valid_from: '2026-04-01',
      valid_to: null,
      day_of_week: [6, 7],
    })
    expect(findCall('shift_premium_rules', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('maps a database error to INTERNAL_ERROR', async () => {
    enqueue({ error: { message: 'boom' } })
    const result = await listShiftPremiumRules(client, { companyId: 'company-1' })
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
  })
})

describe('checkNamedEmployees', () => {
  it('skips the lookup for an empty list', async () => {
    const result = await checkNamedEmployees(client, 'company-1', [])
    expect(result).toEqual({ ok: true, data: { foreign: [], hourly: [] } })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns the ids the company does not own and the hourly-paid ones', async () => {
    enqueue({ data: [{ id: EMP_A, salary_type: 'hourly' }] })
    const result = await checkNamedEmployees(client, 'company-1', [EMP_A, EMP_B])
    expect(result).toEqual({ ok: true, data: { foreign: [EMP_B], hourly: [EMP_A] } })
    expect(findCall('employees', 'in')).toEqual(['id', [EMP_A, EMP_B]])
  })
})

describe('createShiftPremiumRule', () => {
  const input = CreateShiftPremiumRuleSchema.parse({
    name: 'OB helg',
    day_of_week: [7, 6],
    start_time: '00:00',
    end_time: '23:59',
    premium_percent: 100,
    valid_from: '2026-04-01',
    item_type: 'ob_weekend',
    priority: 5,
    applies_to_all_employees: false,
    applies_to_employee_ids: [EMP_A],
  })

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

  it('refuses an hourly-paid employee on a monthly_divisor rule', async () => {
    enqueue({ data: [{ id: EMP_A, salary_type: 'hourly' }] })
    const divisorInput = CreateShiftPremiumRuleSchema.parse({
      ...input,
      amount_form: 'monthly_divisor',
      premium_percent: null,
      monthly_divisor: 480,
    })
    const result = await createShiftPremiumRule(client, { companyId: 'company-1', userId: 'u', input: divisorInput })
    expect(result).toMatchObject({
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_HOURLY_EMPLOYEE',
      details: { hourly_employee_ids: [EMP_A] },
    })
    expect(findCall('shift_premium_rules', 'insert')).toBeUndefined()
  })

  it('inserts with sorted weekdays, the form fields and the creator', async () => {
    enqueue({ data: [{ id: EMP_A, salary_type: 'monthly' }] })
    enqueue({ data: { ...stored, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] } })
    const result = await createShiftPremiumRule(client, { companyId: 'company-1', userId: 'u', input })
    expect(result.ok).toBe(true)
    const inserted = findCall('shift_premium_rules', 'insert')?.[0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      day_of_week: [6, 7],
      created_by: 'u',
      company_id: 'company-1',
      amount_form: 'percent_of_hourly',
      premium_percent: 100,
      monthly_divisor: null,
      sek_per_hour: null,
      hourly_divisor: null,
      valid_from: '2026-04-01',
      valid_to: null,
    })
  })

  it('maps a CHECK violation to VALIDATION_ERROR', async () => {
    enqueue({ data: [{ id: EMP_A, salary_type: 'monthly' }] })
    enqueue({ error: { code: '23514', message: 'check' } })
    const result = await createShiftPremiumRule(client, { companyId: 'company-1', userId: 'u', input })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('CreateShiftPremiumRuleSchema', () => {
  const base = {
    name: 'OB kväll',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '18:00',
    end_time: '06:00',
    valid_from: '2025-04-01',
    item_type: 'ob_weekday_evening',
  }

  it('takes exactly the field of the form', () => {
    expect(CreateShiftPremiumRuleSchema.safeParse({ ...base, amount_form: 'monthly_divisor', monthly_divisor: 480 }).success).toBe(true)
    expect(CreateShiftPremiumRuleSchema.safeParse({ ...base, amount_form: 'sek_per_hour', sek_per_hour: 27.59 }).success).toBe(true)
    // percent_of_hourly is the default form.
    expect(CreateShiftPremiumRuleSchema.safeParse({ ...base, premium_percent: 50, hourly_divisor: 166 }).success).toBe(true)

    const twoFields = CreateShiftPremiumRuleSchema.safeParse({
      ...base,
      amount_form: 'monthly_divisor',
      monthly_divisor: 480,
      premium_percent: 50,
    })
    expect(twoFields.success).toBe(false)
    expect(twoFields.error?.issues[0].path).toEqual(['premium_percent'])

    const missing = CreateShiftPremiumRuleSchema.safeParse({ ...base, amount_form: 'sek_per_hour' })
    expect(missing.error?.issues[0].path).toEqual(['sek_per_hour'])

    const divisorOnSek = CreateShiftPremiumRuleSchema.safeParse({
      ...base,
      amount_form: 'sek_per_hour',
      sek_per_hour: 20,
      hourly_divisor: 166,
    })
    expect(divisorOnSek.error?.issues[0].path).toEqual(['hourly_divisor'])
  })

  it('requires valid_from and orders the validity', () => {
    const withoutFrom: Record<string, unknown> = { ...base, premium_percent: 50 }
    delete withoutFrom.valid_from
    expect(CreateShiftPremiumRuleSchema.safeParse(withoutFrom).success).toBe(false)
    const backwards = CreateShiftPremiumRuleSchema.safeParse({ ...base, premium_percent: 50, valid_to: '2025-03-31' })
    expect(backwards.error?.issues[0].path).toEqual(['valid_to'])
    expect(CreateShiftPremiumRuleSchema.safeParse({ ...base, premium_percent: 50, valid_to: '2025-04-01' }).success).toBe(true)
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
    enqueue({ data: [{ id: EMP_A, salary_type: 'monthly' }] })
    enqueue({ data: { ...stored, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] } })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-1',
      input: { applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] },
    })
    expect(result.ok).toBe(true)
    // Only the patched columns reach PostgREST (undefined is dropped on the wire).
    const update = findCall('shift_premium_rules', 'update')?.[0] as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(update))).toEqual({
      applies_to_all_employees: false,
      applies_to_employee_ids: [EMP_A],
    })
  })

  it('switches the form and clears the old form fields', async () => {
    enqueue({ data: stored })
    enqueue({ data: { ...stored, amount_form: 'sek_per_hour', premium_percent: null, hourly_divisor: null, sek_per_hour: '27.59' } })
    const input = UpdateShiftPremiumRuleSchema.parse({ amount_form: 'sek_per_hour', sek_per_hour: 27.59 })
    const result = await updateShiftPremiumRule(client, { companyId: 'company-1', ruleId: 'rule-1', input })
    expect(result.ok).toBe(true)
    const update = findCall('shift_premium_rules', 'update')?.[0] as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(update))).toEqual({
      amount_form: 'sek_per_hour',
      premium_percent: null,
      monthly_divisor: null,
      sek_per_hour: 27.59,
      hourly_divisor: null,
    })
  })

  it('refuses the field of another form without switching', async () => {
    enqueue({ data: stored })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-1',
      input: { monthly_divisor: 480 },
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_FORM_INVALID',
      details: { field: 'monthly_divisor' },
    })
  })

  it('refuses a switch that leaves the new form without its field', async () => {
    enqueue({ data: stored })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-1',
      input: { amount_form: 'monthly_divisor' },
    })
    expect(result).toMatchObject({ ok: false, code: 'SHIFT_PREMIUM_RULE_FORM_INVALID', details: { field: 'monthly_divisor' } })
  })

  it('checks the validity order against the stored valid_from', async () => {
    enqueue({ data: stored })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-1',
      input: { valid_to: '2026-03-31' },
    })
    expect(result).toMatchObject({ ok: false, code: 'SHIFT_PREMIUM_RULE_VALIDITY_INVALID' })
    expect(findCall('shift_premium_rules', 'update')).toBeUndefined()
  })

  it('re-checks the named employees when a rule turns into monthly_divisor', async () => {
    const named = { ...stored, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] }
    enqueue({ data: named })
    enqueue({ data: [{ id: EMP_A, salary_type: 'hourly' }] })
    const result = await updateShiftPremiumRule(client, {
      companyId: 'company-1',
      ruleId: 'rule-1',
      input: { amount_form: 'monthly_divisor', monthly_divisor: 480 },
    })
    expect(result).toMatchObject({ ok: false, code: 'SHIFT_PREMIUM_RULE_HOURLY_EMPLOYEE' })
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
    expect(result).toEqual({ ok: true, data: { id: 'rule-1', deleted: true, deactivated: false } })
    expect(findCall('shift_premium_rules', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('switches a rule off when a payslip line derives from it', async () => {
    enqueue({ error: { code: '23503', message: 'violates foreign key constraint' } })
    enqueue({ data: [{ id: 'rule-1' }] })
    const result = await deleteShiftPremiumRule(client, { companyId: 'company-1', ruleId: 'rule-1' })
    expect(result).toEqual({ ok: true, data: { id: 'rule-1', deleted: false, deactivated: true } })
    expect(findCall('shift_premium_rules', 'update')?.[0]).toEqual({ is_active: false })
  })
})
