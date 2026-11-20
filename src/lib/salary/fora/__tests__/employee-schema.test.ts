/**
 * The Fora code on the employee create and update schemas (lib/api/schemas.ts),
 * which every door (dashboard, v1, MCP) parses.
 */
import { describe, it, expect } from 'vitest'
import { CreateEmployeeSchema, UpdateEmployeeSchema } from '@/lib/api/schemas'
import { FORA_FOK_EMPLOYEE_ONLY, FORA_FOK_ID_FORMAT, FORA_FOK_START_REQUIRED } from '../markup'

const BASE = {
  first_name: 'Kalle',
  last_name: 'Hall',
  personnummer: '195408012230',
  employment_start: '2024-01-01',
  monthly_salary: 31250,
  tax_table_number: 33,
  tax_municipality: 'Stockholm',
}

function messages(result: ReturnType<typeof CreateEmployeeSchema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((i) => i.message)
}

describe('CreateEmployeeSchema: Fora code', () => {
  it('accepts a typed code in any case and stores it upper-cased', () => {
    const result = CreateEmployeeSchema.safeParse({ ...BASE, fora_fok_id: ' fok306834 ', fora_fok_start_date: '2024-01-01' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.fora_fok_id).toBe('FOK306834')
  })

  it('refuses a malformed code, a code without a date, and a code on an owner', () => {
    expect(messages(CreateEmployeeSchema.safeParse({ ...BASE, fora_fok_id: 'FOK12', fora_fok_start_date: '2024-01-01' }))).toContain(FORA_FOK_ID_FORMAT)
    expect(messages(CreateEmployeeSchema.safeParse({ ...BASE, fora_fok_id: 'FOK306834' }))).toContain(FORA_FOK_START_REQUIRED)
    expect(
      messages(
        CreateEmployeeSchema.safeParse({ ...BASE, employment_type: 'company_owner', fora_fok_id: 'FOK306834', fora_fok_start_date: '2024-01-01' }),
      ),
    ).toContain(FORA_FOK_EMPLOYEE_ONLY)
  })

  it('needs neither field', () => {
    expect(CreateEmployeeSchema.safeParse(BASE).success).toBe(true)
  })
})

describe('UpdateEmployeeSchema: Fora code', () => {
  it('accepts null to clear both', () => {
    const result = UpdateEmployeeSchema.safeParse({ fora_fok_id: null, fora_fok_start_date: null })
    expect(result.success).toBe(true)
  })

  it('normalizes a typed code', () => {
    const result = UpdateEmployeeSchema.safeParse({ fora_fok_id: 'fok301123' })
    expect(result.success && result.data.fora_fok_id).toBe('FOK301123')
  })
})
