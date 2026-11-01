/**
 * Unit tests for lib/salary/employee-commands.ts: what the MCP executors
 * (create_employee / update_employee) are allowed to write.
 *
 * The writable set is read off the request schemas (crm#1133). It used to be
 * a second hand-written list beside them, and is_active, which the MCP tool
 * advertised, was in neither: the schema stripped it on the PATCH routes and
 * this layer dropped it at approval. The tests pin the set to the schemas,
 * is_active to update only, and the defense the allowlist exists for (a
 * tampered pending_operations row cannot reach another column).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { CreateEmployeeSchema, UpdateEmployeeSchema } from '@/lib/api/schemas'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { eventBus } from '@/lib/events'
import { EMPLOYEE_UPDATE_REQUEST_ONLY_KEYS } from '@/lib/salary/employee-update-rules'
import { invalidateRunCalculation } from '@/lib/salary/invalidate-calculation'

vi.mock('@/lib/company/context', () => ({
  getCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

import {
  EMPLOYEE_CREATE_COLUMNS,
  EMPLOYEE_UPDATE_COLUMNS,
  createEmployee,
  sealPersonnummer,
  updateEmployee,
} from '@/lib/salary/employee-commands'

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

/** A stored row that passes every merged-state rule. */
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
  tax_table_number: 33,
  is_sidoinkomst: false,
  f_skatt_status: 'a_skatt',
  vaxa_stod_eligible: false,
  jamkning_percentage: null,
  jamkning_valid_from: null,
  jamkning_valid_to: null,
  is_active: true,
}

/** What the UPDATE and INSERT chains select back. */
const summaryRow = (isActive: boolean) => ({
  id: EMPLOYEE_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer: ENCRYPTED_PNR,
  is_active: isActive,
})

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('writable columns', () => {
  it('are the keys of the request schemas, minus personnummer and the request-only keys', () => {
    const without = (shape: object) =>
      Object.keys(shape)
        .filter((key) => key !== 'personnummer' && !EMPLOYEE_UPDATE_REQUEST_ONLY_KEYS.has(key))
        .sort()

    expect([...EMPLOYEE_CREATE_COLUMNS].sort()).toEqual(without(CreateEmployeeSchema.shape))
    expect([...EMPLOYEE_UPDATE_COLUMNS].sort()).toEqual(without(UpdateEmployeeSchema.shape))
  })

  it('never include a request-only key: the kollektivavtal confirmation is no column', () => {
    expect(EMPLOYEE_UPDATE_REQUEST_ONLY_KEYS.has('sammaloneregeln_kollektivavtal_confirmed')).toBe(true)
    expect(Object.keys(UpdateEmployeeSchema.shape)).toContain('sammaloneregeln_kollektivavtal_confirmed')
    expect(EMPLOYEE_UPDATE_COLUMNS.has('sammaloneregeln_kollektivavtal_confirmed')).toBe(false)
  })

  it('never include the identity or tenancy columns', () => {
    for (const column of ['personnummer', 'personnummer_last4', 'id', 'company_id', 'user_id']) {
      expect(EMPLOYEE_CREATE_COLUMNS.has(column), `create: ${column}`).toBe(false)
      expect(EMPLOYEE_UPDATE_COLUMNS.has(column), `update: ${column}`).toBe(false)
    }
  })

  it('carry is_active on update only: a new employee is always created active', () => {
    expect(EMPLOYEE_UPDATE_COLUMNS.has('is_active')).toBe(true)
    expect(EMPLOYEE_CREATE_COLUMNS.has('is_active')).toBe(false)
    // The create schema itself drops the key, so no door can create an
    // inactive employee.
    expect(Object.keys(CreateEmployeeSchema.shape)).not.toContain('is_active')
    // Apart from that one key the two verbs write the same columns.
    expect([...EMPLOYEE_UPDATE_COLUMNS].filter((c) => c !== 'is_active').sort()).toEqual(
      [...EMPLOYEE_CREATE_COLUMNS].sort(),
    )
  })
})

describe('updateEmployee', () => {
  const args = (patch: Record<string, unknown>) => ({ companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, patch })

  it('writes is_active true for an inactive employee: the reactivation reaches the row', async () => {
    mock.enqueue({ data: { ...STORED, is_active: false } }) // fetch existing
    mock.enqueue({ data: summaryRow(true) }) // update

    const result = await updateEmployee(supabase, args({ is_active: true }))

    expect(result).toMatchObject({ ok: true, data: { employee_id: EMPLOYEE_ID, is_active: true } })
    expect(mock.findCalls('employees', 'update')).toEqual([[{ is_active: true }]])
  })

  it('writes is_active false: the same single-column write the soft delete makes', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: summaryRow(false) })

    const result = await updateEmployee(supabase, args({ is_active: false }))

    expect(result).toMatchObject({ ok: true, data: { is_active: false } })
    expect(mock.findCalls('employees', 'update')).toEqual([[{ is_active: false }]])
  })

  it('writes the flag beside another field instead of dropping it', async () => {
    mock.enqueue({ data: { ...STORED, is_active: false } })
    mock.enqueue({ data: summaryRow(true) })

    await updateEmployee(supabase, args({ is_active: true, phone: '0700000000' }))

    expect(mock.findCalls('employees', 'update')).toEqual([[{ is_active: true, phone: '0700000000' }]])
  })

  it('scopes the read and the write to the company and the employee', async () => {
    mock.enqueue({ data: { ...STORED, is_active: false } })
    mock.enqueue({ data: summaryRow(true) })

    await updateEmployee(supabase, args({ is_active: true }))

    expect(mock.findCalls('employees', 'eq')).toEqual([
      ['id', EMPLOYEE_ID],
      ['company_id', COMPANY_ID],
      ['id', EMPLOYEE_ID],
      ['company_id', COMPANY_ID],
    ])
  })

  it('drops columns outside the schema from a tampered patch and writes the rest', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: summaryRow(true) })

    await updateEmployee(
      supabase,
      args({ phone: '0700000000', company_id: 'other-company', user_id: 'other-user', personnummer_last4: '9999' }),
    )

    expect(mock.findCalls('employees', 'update')).toEqual([[{ phone: '0700000000' }]])
  })

  it('answers a patch with nothing writable with the row as it is, and writes nothing', async () => {
    // A tampered key (company_id) is not writable, so nothing is left: the
    // v1 PATCH has always answered an empty patch with the current row. The
    // MCP tool refuses to stage an empty patch before it gets here.
    mock.enqueue({ data: STORED })
    const result = await updateEmployee(supabase, args({ company_id: 'other-company' }))

    expect(result).toMatchObject({ ok: true, data: { employee_id: EMPLOYEE_ID, changes: {} } })
    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })

  it('answers EMPLOYEE_NOT_FOUND for an id that is not in the company, without writing', async () => {
    mock.enqueue({ data: null })

    const result = await updateEmployee(supabase, args({ is_active: true }))

    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })

  it('still refuses personnummer: identity is immutable', async () => {
    const result = await updateEmployee(supabase, args({ is_active: true, personnummer: '190001010008' }))

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'personnummer' } })
    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })
})

describe('createEmployee', () => {
  it('ignores is_active: the row is inserted without the key, so the column default (active) applies', async () => {
    mock.enqueue({ data: summaryRow(true) }) // insert

    const result = await createEmployee(supabase, {
      companyId: COMPANY_ID,
      userId: USER_ID,
      input: {
        first_name: 'Anna',
        last_name: 'Andersson',
        employment_start: '2024-01-15',
        salary_type: 'monthly',
        monthly_salary: 35000,
        is_active: false,
        personnummer_encrypted: ENCRYPTED_PNR,
        personnummer_last4: '0000',
      },
    })

    expect(result).toMatchObject({ ok: true, data: { is_active: true } })
    const [inserted] = mock.findCall('employees', 'insert') as [Record<string, unknown>]
    expect(inserted).not.toHaveProperty('is_active')
    expect(inserted).toMatchObject({ company_id: COMPANY_ID, first_name: 'Anna', monthly_salary: 35000 })
  })

  it('announces the new employee with ids only (employee.created), never on a dry run or a refusal', async () => {
    const emit = vi.spyOn(eventBus, 'emit')
    const input = {
      first_name: 'Anna',
      last_name: 'Andersson',
      employment_start: '2024-01-15',
      personnummer_encrypted: ENCRYPTED_PNR,
      personnummer_last4: '0000',
    }

    await createEmployee(supabase, { companyId: COMPANY_ID, userId: USER_ID, input, dryRun: true })
    mock.enqueue({ error: { code: '23505', message: 'duplicate', constraint: 'employees_personnummer_key' } })
    await createEmployee(supabase, { companyId: COMPANY_ID, userId: USER_ID, input })
    expect(emit).not.toHaveBeenCalled()

    mock.enqueue({ data: summaryRow(true) })
    await createEmployee(supabase, { companyId: COMPANY_ID, userId: USER_ID, input })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      type: 'employee.created',
      payload: { employeeId: EMPLOYEE_ID, userId: USER_ID, companyId: COMPANY_ID },
    })
    emit.mockRestore()
  })
})

describe('sealPersonnummer', () => {
  it('seals a valid personnummer: ciphertext and last four digits, never the plaintext', () => {
    const sealed = sealPersonnummer('190001010008')
    expect(sealed.ok).toBe(true)
    if (sealed.ok) {
      expect(sealed.identity.personnummer_last4).toBe('0008')
      expect(sealed.identity.personnummer_encrypted).not.toContain('190001010008')
    }
  })

  it('refuses an empty value, a masked display value and a wrong check digit, without echoing the input', () => {
    expect(sealPersonnummer('')).toMatchObject({ ok: false, message: expect.stringContaining('kan inte tömmas') })
    expect(sealPersonnummer(null)).toMatchObject({ ok: false })
    expect(sealPersonnummer('19000101-XXXX')).toMatchObject({ ok: false, message: expect.stringContaining('Maskerat') })
    const wrong = sealPersonnummer('190001010000')
    expect(wrong).toEqual({ ok: false, message: 'Ogiltigt kontrollnummer (Luhn)' })
  })
})

describe('updateEmployee: a corrected monthly salary reaches draft runs (crm#1337)', () => {
  const args = (patch: Record<string, unknown>, dryRun = false) => ({
    companyId: COMPANY_ID,
    employeeId: EMPLOYEE_ID,
    patch,
    dryRun,
  })

  it('moves the draft rows that still hold the old salary to the new one', async () => {
    mock.enqueue({ data: STORED }) // fetch existing
    mock.enqueue({ data: summaryRow(true) }) // employee update
    mock.enqueue({ data: [{ id: 'run-draft' }] }) // draft runs
    mock.enqueue({ data: [{ id: 'sre-1' }] }) // compare-and-set
    mock.enqueue({ data: null }) // Grundlön line

    const result = await updateEmployee(supabase, args({ monthly_salary: 38000 }))

    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_run_employees', 'update')).toEqual([{ monthly_salary: 38000 }])
    // The calculation is cleared by the one step, before anything is written.
    expect(invalidateRunCalculation).toHaveBeenCalledWith(supabase, expect.anything(), { employeeId: expect.any(String) })
    // Only rows still on the old salary follow.
    expect(mock.findCalls('salary_run_employees', 'eq')).toContainEqual(['monthly_salary', 35000])
  })

  it('leaves draft runs alone when the salary is unchanged, and on a dry run', async () => {
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: summaryRow(true) })
    const other = await updateEmployee(supabase, args({ phone: '0700000000' }))
    mock.enqueue({ data: STORED })
    mock.enqueue({ data: summaryRow(true) })
    const same = await updateEmployee(supabase, args({ monthly_salary: 35000 }))
    mock.enqueue({ data: STORED })
    const dry = await updateEmployee(supabase, args({ monthly_salary: 38000 }, true))

    expect([other.ok, same.ok, dry.ok]).toEqual([true, true, true])
    expect(mock.findCalls('employees', 'update')).toHaveLength(2)
    expect(mock.findCalls('salary_runs', 'select')).toHaveLength(0)
    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
  })
})

describe('updateEmployee: dry run and columns', () => {
  it('validates the merged row and answers it masked in the caller\'s columns, writing nothing', async () => {
    mock.enqueue({ data: STORED })

    const result = await updateEmployee(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      patch: { phone: '0700000000' },
      dryRun: true,
      columns: 'id, personnummer, phone',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result.data.row).sort()).toEqual(['id', 'personnummer_masked', 'phone'])
      expect(result.data.row.phone).toBe('0700000000')
      expect(result.data.previous.phone).toBeNull()
      expect(result.data.changes).toEqual({ phone: '0700000000' })
    }
    expect(mock.findCall('employees', 'update')).toBeUndefined()
  })
})

