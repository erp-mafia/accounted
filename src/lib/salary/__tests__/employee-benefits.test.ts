/**
 * Unit tests for lib/salary/employee-benefits.ts (payroll gap-closure 5).
 *
 * Bike derivation, the merged validity-period check, the bike-only
 * annual_market_value rule, dry-run outcomes that never write, hard-delete
 * hit/no-op reporting, Postgres error mapping, and the v1 resource mapper.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { BENEFIT_PERIOD_ORDER_MESSAGE } from '@/lib/api/schemas'
import {
  ANNUAL_MARKET_VALUE_BIKE_ONLY_MESSAGE,
  buildEmployeeBenefitInsert,
  createEmployeeBenefit,
  deleteEmployeeBenefit,
  isBenefitPeriodOrdered,
  listEmployeeBenefits,
  toEmployeeBenefitResource,
  updateEmployeeBenefit,
  type EmployeeBenefitRow,
} from '@/lib/salary/employee-benefits'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BENEFIT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

const STORED: EmployeeBenefitRow = {
  id: BENEFIT_ID,
  employee_id: EMPLOYEE_ID,
  benefit_type: 'other',
  description: 'Friskvård',
  monthly_value: 500,
  valid_from: '2026-06-01',
  valid_to: '2026-12-31',
  metadata: {},
  is_active: true,
  created_at: '2026-05-01T08:00:00Z',
  updated_at: '2026-05-01T08:00:00Z',
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

function fromCalls(): string[] {
  return (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('buildEmployeeBenefitInsert', () => {
  it('stores the supplied monthly value for non-bike types with defaults filled in', () => {
    const row = buildEmployeeBenefitInsert(
      { benefit_type: 'car', description: 'Bilförmån', monthly_value: 4275, valid_from: '2026-01-01' },
      EMPLOYEE_ID,
    )
    expect(row).toEqual({
      employee_id: EMPLOYEE_ID,
      benefit_type: 'car',
      description: 'Bilförmån',
      monthly_value: 4275,
      valid_from: '2026-01-01',
      valid_to: null,
      metadata: {},
      is_active: true,
    })
  })

  it('derives the bike monthly value from annual_market_value and records the inputs', () => {
    // (15 000 - 3 000 tax-free) / 12 = 1 000 kr/month.
    const row = buildEmployeeBenefitInsert(
      {
        benefit_type: 'bike',
        description: 'Cykelförmån',
        annual_market_value: 15000,
        valid_from: '2026-03-01',
        metadata: { model: 'Crescent' },
      },
      EMPLOYEE_ID,
    )
    expect(row.monthly_value).toBe(1000)
    expect(row.metadata).toEqual({
      model: 'Crescent',
      annual_market_value: 15000,
      annual_taxable: 12000,
      tax_free_portion: 3000,
    })
  })

  it('keeps an explicit monthly_value on a bike row when no annual value is given', () => {
    const row = buildEmployeeBenefitInsert(
      { benefit_type: 'bike', description: 'Cykelförmån', monthly_value: 250, valid_from: '2026-03-01' },
      EMPLOYEE_ID,
    )
    expect(row.monthly_value).toBe(250)
    expect(row.metadata).toEqual({})
  })
})

describe('isBenefitPeriodOrdered', () => {
  it('is inclusive and treats a null valid_to as open-ended', () => {
    expect(isBenefitPeriodOrdered('2026-06-01', '2026-06-01')).toBe(true)
    expect(isBenefitPeriodOrdered('2026-06-01', '2026-05-31')).toBe(false)
    expect(isBenefitPeriodOrdered('2026-06-01', null)).toBe(true)
    expect(isBenefitPeriodOrdered(null, '2026-05-31')).toBe(true)
  })
})

describe('listEmployeeBenefits', () => {
  it('returns EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mock.enqueue({ data: null })
    const result = await listEmployeeBenefits(supabase, { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(fromCalls()).toEqual(['employees'])
  })

  it('lists rows for the employee', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [STORED] })
    const result = await listEmployeeBenefits(supabase, { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([STORED])
    expect(fromCalls()).toEqual(['employees', 'employee_benefits'])
    expect(mock.findCalls('employee_benefits', 'eq')).not.toContainEqual(['is_active', true])
  })

  it('applies the is_active filter when asked', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [] })
    await listEmployeeBenefits(supabase, { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, active: false })
    expect(mock.findCalls('employee_benefits', 'eq')).toContainEqual(['is_active', false])
  })

  it('maps a read failure to INTERNAL_ERROR', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: { code: '57014', message: 'statement timeout' } })
    const result = await listEmployeeBenefits(supabase, { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })
})

describe('createEmployeeBenefit', () => {
  const input = {
    benefit_type: 'car' as const,
    description: 'Bilförmån',
    monthly_value: 4275,
    valid_from: '2026-01-01',
  }

  it('returns EMPLOYEE_NOT_FOUND before touching employee_benefits', async () => {
    mock.enqueue({ data: null })
    const result = await createEmployeeBenefit(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input,
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(fromCalls()).toEqual(['employees'])
  })

  it('inserts the row with tenancy columns and returns it', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: { ...STORED, benefit_type: 'car', monthly_value: 4275 } })

    const result = await createEmployeeBenefit(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.committed).toBe(true)
      if (result.data.committed) expect(result.data.row.monthly_value).toBe(4275)
    }
    const [payload] = mock.findCall('employee_benefits', 'insert') ?? []
    expect(payload).toMatchObject({
      employee_id: EMPLOYEE_ID,
      company_id: COMPANY_ID,
      user_id: USER_ID,
      benefit_type: 'car',
      monthly_value: 4275,
      valid_to: null,
      is_active: true,
    })
  })

  it('dry-run returns the derived preview without writing', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })

    const result = await createEmployeeBenefit(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input: { benefit_type: 'bike', description: 'Cykelförmån', annual_market_value: 15000, valid_from: '2026-03-01' },
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.committed).toBe(false)
      if (!result.data.committed) {
        expect(result.data.preview.monthly_value).toBe(1000)
        expect(result.data.preview.metadata.annual_market_value).toBe(15000)
      }
    }
    expect(fromCalls()).toEqual(['employees'])
  })

  it('maps a CHECK violation (23514) on insert to VALIDATION_ERROR with the raw text in details', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: { code: '23514', message: 'violates check constraint "employee_benefits_check"' } })
    const result = await createEmployeeBenefit(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR')
      expect(result.details).toEqual({ message: 'violates check constraint "employee_benefits_check"', pg_code: '23514' })
    }
  })

  it('maps an RLS denial (42501) to DB_PERMISSION_DENIED and anything else to INTERNAL_ERROR', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const denied = await createEmployeeBenefit(supabase, { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, userId: USER_ID, input })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe('DB_PERMISSION_DENIED')

    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    const failed = await createEmployeeBenefit(supabase, { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, userId: USER_ID, input })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('INTERNAL_ERROR')
  })
})

describe('updateEmployeeBenefit', () => {
  const args = { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, benefitId: BENEFIT_ID }

  it('returns NOT_FOUND when the row is not on the employee (zero rows, and PGRST116)', async () => {
    mock.enqueue({ data: null })
    const missing = await updateEmployeeBenefit(supabase, { ...args, patch: { monthly_value: 100 } })
    expect(missing).toEqual({ ok: false, code: 'NOT_FOUND', details: { resource: 'employee_benefit' } })

    mock.enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    const single = await updateEmployeeBenefit(supabase, { ...args, patch: { monthly_value: 100 } })
    expect(single.ok).toBe(false)
    if (!single.ok) expect(single.code).toBe('NOT_FOUND')
  })

  it('reports a failed lookup as INTERNAL_ERROR, not NOT_FOUND', async () => {
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    const result = await updateEmployeeBenefit(supabase, { ...args, patch: { monthly_value: 100 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })

  it('rejects a valid_to-only patch that predates the stored valid_from before writing', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeBenefit(supabase, { ...args, patch: { valid_to: '2026-05-31' } })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'valid_to', message: BENEFIT_PERIOD_ORDER_MESSAGE },
    })
    expect(fromCalls()).toEqual(['employee_benefits'])
    expect(mock.findCall('employee_benefits', 'update')).toBeUndefined()
  })

  it('rejects a valid_from-only patch that postdates the stored valid_to', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeBenefit(supabase, { ...args, patch: { valid_from: '2027-01-01' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('accepts valid_to: null (clears the end date) and equal dates', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: { ...STORED, valid_to: null } })
    const cleared = await updateEmployeeBenefit(supabase, { ...args, patch: { valid_to: null } })
    expect(cleared.ok).toBe(true)
    expect(mock.findCall('employee_benefits', 'update')).toEqual([{ valid_to: null }])

    mock.enqueue({ data: STORED })
    mock.enqueue({ data: { ...STORED, valid_to: '2026-06-01' } })
    const equal = await updateEmployeeBenefit(supabase, { ...args, patch: { valid_to: '2026-06-01' } })
    expect(equal.ok).toBe(true)
  })

  it('refuses annual_market_value on a non-bike row', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeBenefit(supabase, { ...args, patch: { annual_market_value: 12000 } })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'annual_market_value', message: ANNUAL_MARKET_VALUE_BIKE_ONLY_MESSAGE },
    })
    expect(mock.findCall('employee_benefits', 'update')).toBeUndefined()
  })

  it('re-derives the bike monthly value and merges metadata on annual_market_value', async () => {
    const bike: EmployeeBenefitRow = {
      ...STORED,
      benefit_type: 'bike',
      monthly_value: 1000,
      metadata: { model: 'Crescent', annual_market_value: 15000, annual_taxable: 12000, tax_free_portion: 3000 },
    }
    mock.enqueue({ data: bike })
    mock.enqueue({ data: { ...bike, monthly_value: 1500 } })

    const result = await updateEmployeeBenefit(supabase, {
      ...args,
      patch: { annual_market_value: 21000, monthly_value: 999, metadata: { colour: 'red' } },
    })

    expect(result.ok).toBe(true)
    const [updates] = mock.findCall('employee_benefits', 'update') ?? []
    // (21 000 - 3 000) / 12 = 1 500: the derived value wins over monthly_value.
    expect(updates).toEqual({
      monthly_value: 1500,
      metadata: {
        model: 'Crescent',
        colour: 'red',
        annual_market_value: 21000,
        annual_taxable: 18000,
        tax_free_portion: 3000,
      },
    })
  })

  it('dry-run returns the merged row without writing', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeBenefit(supabase, {
      ...args,
      patch: { is_active: false, description: 'Friskvård (avslutad)' },
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.committed).toBe(false)
      if (!result.data.committed) {
        expect(result.data.preview).toEqual({ ...STORED, is_active: false, description: 'Friskvård (avslutad)' })
      }
    }
    expect(fromCalls()).toEqual(['employee_benefits'])
  })

  it('maps a CHECK violation on the update to the period message, and PGRST116 to NOT_FOUND', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: null, error: { code: '23514', message: 'violates check constraint "employee_benefits_check"' } })
    const check = await updateEmployeeBenefit(supabase, { ...args, patch: { monthly_value: 100 } })
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.code).toBe('VALIDATION_ERROR')
      expect(check.details).toMatchObject({ field: 'valid_to', message: BENEFIT_PERIOD_ORDER_MESSAGE, pg_code: '23514' })
    }

    mock.enqueue({ data: STORED })
    mock.enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    const gone = await updateEmployeeBenefit(supabase, { ...args, patch: { monthly_value: 100 } })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.code).toBe('NOT_FOUND')
  })

  it('treats an empty patch as a no-op and returns the stored row', async () => {
    mock.enqueue({ data: STORED })
    const result = await updateEmployeeBenefit(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      benefitId: BENEFIT_ID,
      patch: {},
    })
    expect(result).toEqual({ ok: true, data: { committed: true, row: STORED } })
    expect(mock.findCall('employee_benefits', 'update')).toBeUndefined()
  })

  it('returns the updated row on the happy path', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: { ...STORED, monthly_value: 100 } })
    const result = await updateEmployeeBenefit(supabase, { ...args, patch: { monthly_value: 100 } })
    expect(result.ok).toBe(true)
    if (result.ok && result.data.committed) expect(result.data.row.monthly_value).toBe(100)
  })
})

describe('deleteEmployeeBenefit', () => {
  const args = { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, benefitId: BENEFIT_ID }

  // The NO ACTION foreign key's refusal, as PostgREST surfaces it (#2801).
  const FK_VIOLATION = {
    code: '23503',
    message:
      'update or delete on table "employee_benefits" violates foreign key constraint "salary_line_items_source_benefit_id_fkey" on table "salary_line_items"',
  }
  const NO_LINES = { data: null, count: 0 } // the pre-check saw no derived line

  it('reports a hit when a row came back from the delete', async () => {
    mock.enqueue(NO_LINES)
    mock.enqueue({ data: [{ id: BENEFIT_ID }] })
    const result = await deleteEmployeeBenefit(supabase, args)
    expect(result).toEqual({ ok: true, data: { committed: true, deleted: true } })
    expect(mock.findCall('employee_benefits', 'delete')).toBeDefined()
    expect(mock.findCall('employee_benefits', 'update')).toBeUndefined()
  })

  it('reports a no-op when nothing matched', async () => {
    mock.enqueue(NO_LINES)
    mock.enqueue({ data: [] })
    const result = await deleteEmployeeBenefit(supabase, args)
    expect(result).toEqual({ ok: true, data: { committed: true, deleted: false } })
  })

  it('dry-run returns the row that would go, or NOT_FOUND, without deleting', async () => {
    mock.enqueue({ data: STORED })
    const found = await deleteEmployeeBenefit(supabase, { ...args, dryRun: true })
    expect(found).toEqual({ ok: true, data: { committed: false, preview: STORED } })
    expect(mock.findCall('employee_benefits', 'delete')).toBeUndefined()

    mock.enqueue({ data: null })
    const missing = await deleteEmployeeBenefit(supabase, { ...args, dryRun: true })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND')
  })

  it('deactivates instead of deleting when a payslip line already derives from the row', async () => {
    mock.enqueue({ data: null, count: 2 })
    mock.enqueue({ data: [{ id: BENEFIT_ID }] })
    const result = await deleteEmployeeBenefit(supabase, args)
    expect(result).toEqual({ ok: true, data: { committed: true, deleted: false, deactivated: true } })
    expect(mock.findCall('employee_benefits', 'delete')).toBeUndefined()
    // The switch-off is the only write, and the reference count is scoped to
    // the company's lines that point at this row (#2695).
    expect(mock.findCall('employee_benefits', 'update')).toEqual([{ is_active: false }])
    expect(mock.findCalls('salary_line_items', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['source_benefit_id', BENEFIT_ID],
    ])
  })

  it('deactivates when a line is derived after the count: the foreign key refuses the delete (#2801)', async () => {
    // The race the count could never close. It read 0, a recalculation then
    // committed a derived line, and the delete met the NO ACTION key (23503).
    // Before 20260920190100 the key was SET NULL and this delete succeeded,
    // orphaning that line into an apparent manual one.
    mock.enqueue(NO_LINES)
    mock.enqueue({ data: null, error: FK_VIOLATION })
    mock.enqueue({ data: [{ id: BENEFIT_ID }] })
    const result = await deleteEmployeeBenefit(supabase, args)
    expect(result).toEqual({ ok: true, data: { committed: true, deleted: false, deactivated: true } })
    expect(mock.findCall('employee_benefits', 'delete')).toBeDefined()
    expect(mock.findCall('employee_benefits', 'update')).toEqual([{ is_active: false }])
    expect(fromCalls()).toEqual(['salary_line_items', 'employee_benefits', 'employee_benefits'])
  })

  it('reports a deactivate that matched nothing as neither deleted nor deactivated', async () => {
    mock.enqueue({ data: null, count: 1 })
    mock.enqueue({ data: [] })
    const counted = await deleteEmployeeBenefit(supabase, args)
    expect(counted).toEqual({ ok: true, data: { committed: true, deleted: false, deactivated: false } })

    // Same answer when the refusal came from the key rather than the count.
    mock.enqueue(NO_LINES)
    mock.enqueue({ data: null, error: FK_VIOLATION })
    mock.enqueue({ data: [] })
    const refused = await deleteEmployeeBenefit(supabase, args)
    expect(refused).toEqual({ ok: true, data: { committed: true, deleted: false, deactivated: false } })
  })

  it('maps a failed deactivate after a 23503 through the write-error mapper', async () => {
    mock.enqueue(NO_LINES)
    mock.enqueue({ data: null, error: FK_VIOLATION })
    mock.enqueue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const result = await deleteEmployeeBenefit(supabase, args)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('DB_PERMISSION_DENIED')
  })

  it('maps a failure on the referencing-line count to INTERNAL_ERROR, without writing', async () => {
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    const result = await deleteEmployeeBenefit(supabase, args)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
    expect(mock.findCall('employee_benefits', 'delete')).toBeUndefined()
    expect(mock.findCall('employee_benefits', 'update')).toBeUndefined()
  })

  it('maps a delete failure that is not a foreign key refusal to INTERNAL_ERROR, without deactivating', async () => {
    mock.enqueue(NO_LINES)
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    const result = await deleteEmployeeBenefit(supabase, args)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
    expect(mock.findCall('employee_benefits', 'update')).toBeUndefined()
  })
})

describe('toEmployeeBenefitResource', () => {
  it('qualifies the id and lifts annual_market_value out of metadata', () => {
    const bike = toEmployeeBenefitResource({
      ...STORED,
      benefit_type: 'bike',
      metadata: { annual_market_value: 15000, annual_taxable: 12000, tax_free_portion: 3000 },
    })
    expect(bike.employee_benefit_id).toBe(BENEFIT_ID)
    expect(bike).not.toHaveProperty('id')
    expect(bike).not.toHaveProperty('employee_id')
    expect(bike.annual_market_value).toBe(15000)

    const car = toEmployeeBenefitResource({ ...STORED, benefit_type: 'car' })
    expect(car.annual_market_value).toBeNull()
  })
})
