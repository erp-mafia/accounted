/**
 * v1 PATCH /employees/:id and a changed employment degree on a sammalöneregeln
 * employee (#31, semesterlagen 16 § andra stycket 3-4): 400
 * EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED naming vacation_rule, also under
 * ?dry_run=true; the switch to procentregeln is written; a kollektivavtal
 * confirmation (2 a §) is recorded in audit_log as the API key.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

// The audit row is written with the service role; route it into the same
// recording double so the test can read it back.
let serviceMock: unknown = null
vi.mock('@/lib/supabase/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase/server')>('@/lib/supabase/server')
  return { ...actual, createServiceClient: () => serviceMock }
})

import { createTableMockSupabase } from '@/tests/helpers'
import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { PATCH as updateEmployee } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const url = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`

// Synthetic personnummer (year 1900), a legacy plaintext row: only masked here.
const SAMMALONE = {
  id: EMPLOYEE_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer: '190001010008',
  employment_type: 'employee',
  personnel_category: 'tjansteman',
  employment_start: '2024-01-15',
  employment_end: null,
  employment_degree: 100,
  hours_per_week: 40,
  workdays_per_week: 5,
  salary_type: 'monthly',
  monthly_salary: 35000,
  hourly_rate: null,
  tax_table_number: 33,
  tax_column: 1,
  is_sidoinkomst: false,
  f_skatt_status: 'a_skatt',
  vacation_rule: 'sammaloneregeln',
  vacation_days_per_year: 25,
  vaxa_stod_eligible: false,
  jamkning_percentage: null,
  jamkning_valid_from: null,
  jamkning_valid_to: null,
  is_active: true,
}

function patch(body: Record<string, unknown>, query = '') {
  return updateEmployee(
    new Request(`${url}${query}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID, id: EMPLOYEE_ID }) },
  )
}

function useRows(existing: Record<string, unknown> | null, updated: Record<string, unknown> | null = existing) {
  const mock = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
    employees: [{ data: existing }, { data: updated }],
  })
  mockServiceClient.mockReturnValue(mock.supabase)
  serviceMock = mock.supabase
  return {
    updates: () => mock.payloads('employees', 'update'),
    audits: () => mock.payloads('audit_log', 'insert'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

describe('PATCH /api/v1/companies/:companyId/employees/:id employment degree on sammalöneregeln (#31)', () => {
  it('401 without a valid key, and nothing is written', async () => {
    const rows = useRows(SAMMALONE)
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const res = await patch({ employment_degree: 80 })

    expect(res.status).toBe(401)
    expect(rows.updates()).toEqual([])
  })

  it('400 EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED naming vacation_rule, and nothing is written', async () => {
    const rows = useRows(SAMMALONE)

    const res = await patch({ employment_degree: 80 })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED')
    expect(body.error.details.field).toBe('vacation_rule')
    expect(rows.updates()).toEqual([])
    expect(rows.audits()).toEqual([])
  })

  it('400 under ?dry_run=true too', async () => {
    useRows(SAMMALONE)

    const res = await patch({ employment_degree: 80 }, '?dry_run=true')

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED')
  })

  it('writes the degree together with procentregeln', async () => {
    const rows = useRows(SAMMALONE, { ...SAMMALONE, employment_degree: 80, vacation_rule: 'procentregeln' })

    const res = await patch({ employment_degree: 80, vacation_rule: 'procentregeln' })

    expect(res.status).toBe(200)
    expect(rows.updates()).toEqual([{ employment_degree: 80, vacation_rule: 'procentregeln' }])
    expect(rows.audits()).toEqual([])
  })

  it('writes the degree on a kollektivavtal confirmation and records it as the API key', async () => {
    const rows = useRows(SAMMALONE, { ...SAMMALONE, employment_degree: 80 })

    const res = await patch({ employment_degree: 80, sammaloneregeln_kollektivavtal_confirmed: true })

    expect(res.status).toBe(200)
    expect(rows.updates()).toEqual([{ employment_degree: 80 }])
    expect(rows.audits()).toHaveLength(1)
    expect(rows.audits()[0]).toMatchObject({
      user_id: 'user-1',
      company_id: COMPANY_ID,
      action: 'GUARD_BYPASSED',
      table_name: 'employees',
      record_id: EMPLOYEE_ID,
      actor_type: 'api_key',
      actor_label: 'CI key',
      new_state: { employment_degree_from: 100, employment_degree_to: 80, reason: 'kollektivavtal' },
    })
  })

  it('404 EMPLOYEE_NOT_FOUND for an unknown id', async () => {
    useRows(null)

    const res = await patch({ employment_degree: 80 })

    expect(res.status).toBe(404)
  })
})
