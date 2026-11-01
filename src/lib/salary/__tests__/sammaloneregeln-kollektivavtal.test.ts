/**
 * updateEmployee and a changed employment degree on sammalöneregeln (#31):
 * semesterlagen 16 § andra stycket 3-4 moves the employee to procentregeln,
 * so the one update every door runs refuses the change unless the same
 * request switches the rule or confirms a central kollektivavtal (2 a §).
 * The confirmation is recorded in audit_log; the key is never written to
 * the employees row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'

vi.mock('@/lib/company/context', () => ({
  getCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

const auditInsert = vi.fn()
const serviceFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: serviceFrom }),
}))

import { updateEmployee } from '@/lib/salary/employee-commands'
import {
  EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED,
  SAMMALONEREGELN_DEGREE_CHANGED,
} from '@/lib/salary/employee-update-rules'
import {
  SAMMALONEREGELN_DEGREE_CHANGE_GUARD,
  recordSammaloneregelnKollektivavtal,
} from '@/lib/salary/sammaloneregeln-kollektivavtal-record'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
// Synthetic fixture personnummer (year 1900, zero suffix): only ever masked.
const ENCRYPTED_PNR = encryptPersonnummer('190001010000')

const STORED = {
  id: EMPLOYEE_ID,
  company_id: COMPANY_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer: ENCRYPTED_PNR,
  employment_type: 'employee',
  employment_start: '2024-01-15',
  salary_type: 'monthly',
  monthly_salary: 35000,
  employment_degree: 100,
  hours_per_week: 40,
  workdays_per_week: 5,
  vacation_rule: 'sammaloneregeln',
  tax_table_number: 33,
  is_sidoinkomst: false,
  f_skatt_status: 'a_skatt',
  vaxa_stod_eligible: false,
  jamkning_percentage: null,
  jamkning_valid_from: null,
  jamkning_valid_to: null,
  is_active: true,
}

const WRITTEN = {
  id: EMPLOYEE_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer: ENCRYPTED_PNR,
  is_active: true,
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
  auditInsert.mockResolvedValue({ error: null })
  serviceFrom.mockReturnValue({ insert: auditInsert })
})

const update = (patch: Record<string, unknown>, extra: { dryRun?: boolean } = {}) =>
  updateEmployee(supabase, { companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, patch, userId: USER_ID, ...extra })

describe('updateEmployee: employment degree on sammalöneregeln', () => {
  it('refuses the change with its own code and writes nothing', async () => {
    mock.enqueue({ data: STORED })

    const result = await update({ employment_degree: 80 })

    expect(result).toMatchObject({
      ok: false,
      code: EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED,
      details: { field: 'vacation_rule', message: SAMMALONEREGELN_DEGREE_CHANGED },
    })
    expect(mock.findCall('employees', 'update')).toBeUndefined()
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('refuses it on a dry run too, so MCP staging and v1 dry_run fail early', async () => {
    mock.enqueue({ data: STORED })

    const result = await update({ employment_degree: 80 }, { dryRun: true })

    expect(result).toMatchObject({ ok: false, code: EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED })
  })

  it('writes the change with procentregeln in the same update, and records nothing', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: WRITTEN })

    const result = await update({ employment_degree: 80, vacation_rule: 'procentregeln' })

    expect(result.ok).toBe(true)
    expect(mock.findCalls('employees', 'update')).toEqual([[{ employment_degree: 80, vacation_rule: 'procentregeln' }]])
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('writes the change on a kollektivavtal confirmation, never the key itself, and records who confirmed', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: WRITTEN })

    const result = await runWithActor({ type: 'api_key', label: 'Lönesystem' }, () =>
      update({ employment_degree: 80, sammaloneregeln_kollektivavtal_confirmed: true }),
    )

    expect(result.ok).toBe(true)
    expect(mock.findCalls('employees', 'update')).toEqual([[{ employment_degree: 80 }]])
    expect(serviceFrom).toHaveBeenCalledWith('audit_log')
    expect(auditInsert).toHaveBeenCalledTimes(1)
    expect(auditInsert.mock.calls[0][0]).toMatchObject({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      action: 'GUARD_BYPASSED',
      table_name: 'employees',
      record_id: EMPLOYEE_ID,
      actor_type: 'api_key',
      actor_label: 'Lönesystem',
      old_state: { employment_degree: 100, vacation_rule: 'sammaloneregeln' },
      new_state: {
        guard: SAMMALONEREGELN_DEGREE_CHANGE_GUARD,
        reason: 'kollektivavtal',
        employee_id: EMPLOYEE_ID,
        employment_degree_from: 100,
        employment_degree_to: 80,
      },
    })
    // Ids and degrees only: no personnummer, name or salary in the record.
    const recorded = JSON.stringify(auditInsert.mock.calls[0][0])
    expect(recorded).not.toContain('Anna')
    expect(recorded).not.toContain('35000')
    expect(recorded).not.toContain(ENCRYPTED_PNR)
  })

  it('records nothing on a dry run with the confirmation', async () => {
    mock.enqueue({ data: STORED })

    const result = await update({ employment_degree: 80, sammaloneregeln_kollektivavtal_confirmed: true }, { dryRun: true })

    expect(result.ok).toBe(true)
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('ignores a confirmation that nothing needed: no degree change, no record, no column', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: WRITTEN })

    const result = await update({ phone: '0700000000', sammaloneregeln_kollektivavtal_confirmed: true })

    expect(result.ok).toBe(true)
    expect(mock.findCalls('employees', 'update')).toEqual([[{ phone: '0700000000' }]])
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('keeps the saved update when the record cannot be written', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: WRITTEN })
    auditInsert.mockResolvedValue({ error: { message: 'boom', code: '42501' } })

    const result = await update({ employment_degree: 60, sammaloneregeln_kollektivavtal_confirmed: true })

    expect(result.ok).toBe(true)
    expect(auditInsert).toHaveBeenCalledTimes(1)
  })

  it('lets a schedule change through untouched: workdays and hours are not the sysselsättningsgrad', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: WRITTEN })

    const result = await update({ workdays_per_week: 4, hours_per_week: 32 })

    expect(result.ok).toBe(true)
    expect(auditInsert).not.toHaveBeenCalled()
  })
})

describe('recordSammaloneregelnKollektivavtal', () => {
  it('attributes the record to a signed-in user when no credential scope is open', async () => {
    await recordSammaloneregelnKollektivavtal({
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      employmentDegreeFrom: 100,
      employmentDegreeTo: 50,
    })

    expect(auditInsert.mock.calls[0][0]).toMatchObject({ actor_type: 'user', actor_label: null, user_id: USER_ID })
  })

  it('never throws when the service client throws', async () => {
    serviceFrom.mockImplementation(() => {
      throw new Error('no service role key')
    })

    await expect(
      recordSammaloneregelnKollektivavtal({
        companyId: COMPANY_ID,
        employeeId: EMPLOYEE_ID,
        userId: null,
        employmentDegreeFrom: 100,
        employmentDegreeTo: 50,
      }),
    ).resolves.toBeUndefined()
  })
})
