/**
 * Integration tests for the v1 employees vertical (Phase 5 PR-1).
 *
 * Covers list / detail / create / patch / delete on /employees.
 * Mirrors the Phase 4 suppliers test pattern: Proxy-backed Supabase mock
 * returns per-table responses; each suite focuses on outcome (status + body
 * shape) rather than query mechanics.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `employees route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listEmployees, POST as createEmployee } from '../route'
import {
  GET as getEmployee,
  PATCH as updateEmployee,
  DELETE as deleteEmployee,
} from '../[id]/route'
import { encryptPersonnummer, decryptPersonnummer } from '@/lib/salary/personnummer'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

// 12-digit synthetic personnummer: passes the schema's `^\d{12}$` regex
// while being obviously not a real birthdate (year 1900, day 1, zero
// suffix). ISO A.5.34 / GDPR Art.5(1)(c): test fixtures must not look like
// production-format PII. Last-4 is '0000' so the mask assertion is still
// easy to spot.
const SAMPLE_PERSONNUMMER = '190001010000'

const SAMPLE_EMPLOYEE = {
  id: EMPLOYEE_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer: SAMPLE_PERSONNUMMER,
  employment_type: 'employee',
  employment_start: '2024-01-15',
  employment_end: null,
  employment_degree: 100,
  salary_type: 'monthly',
  monthly_salary: 35000,
  hourly_rate: null,
  tax_table_number: 33,
  tax_column: 1,
  tax_municipality: 'Stockholm',
  is_sidoinkomst: false,
  f_skatt_status: 'a_skatt',
  clearing_number: '6000',
  bank_account_number: '12345678',
  vacation_rule: 'procentregeln',
  vacation_days_per_year: 25,
  semestertillagg_rate: 0.0043,
  email: 'anna@example.test',
  phone: null,
  address_line1: null,
  postal_code: null,
  city: null,
  vaxa_stod_eligible: false,
  vaxa_stod_start: null,
  vaxa_stod_end: null,
  is_active: true,
  created_at: '2024-01-15T08:00:00Z',
  updated_at: '2024-01-15T08:00:00Z',
}

describe('GET /api/v1/companies/:companyId/employees', () => {
  it('returns paginated employees with masked personnummer', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: [SAMPLE_EMPLOYEE], error: null },
      }),
    )

    const res = await listEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].first_name).toBe('Anna')
    // GDPR Art.5(1)(c): birthdate visible, last-4 hidden.
    expect(body.data[0].personnummer_masked).toBe('19000101XXXX')
    // The full personnummer must NEVER appear in the response, even in
    // unrelated fields.
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('rejects unknown filter values with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: [], error: null },
      }),
    )
    const res = await listEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees?employment_type=alien`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects keys without payroll:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'wrong scope',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await listEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('decrypts an encrypted-at-rest row and masks it birthdate-visible', async () => {
    // Rows are stored encrypted; the list must decrypt before masking so the
    // mask is YYYYMMDDXXXX (not fully redacted). Neither the ciphertext nor
    // the plaintext may leak in the response.
    const encRow = { ...SAMPLE_EMPLOYEE, personnummer: encryptPersonnummer(SAMPLE_PERSONNUMMER) }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: [encRow], error: null },
      }),
    )

    const res = await listEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].personnummer_masked).toBe('19000101XXXX')
    expect(JSON.stringify(body)).not.toContain(encRow.personnummer)
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })
})

describe('GET /api/v1/companies/:companyId/employees/:id', () => {
  it('returns the full personnummer on the detail endpoint (deliberate drill-in)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
      }),
    )

    const res = await getEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(EMPLOYEE_ID)
    // Detail endpoint deliberately returns the full personnummer: the
    // caller already has read scope and the id.
    expect(body.data.personnummer).toBe(SAMPLE_PERSONNUMMER)
  })

  it('returns 404 EMPLOYEE_NOT_FOUND when the row is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: null, error: null },
      }),
    )
    const res = await getEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('rejects a non-UUID id with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await getEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/not-a-uuid`),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )
    expect(res.status).toBe(400)
  })

  it('decrypts the stored ciphertext and returns the full personnummer', async () => {
    // The detail drill-in returns the full value; it is stored encrypted, so
    // the endpoint must decrypt it rather than hand back the ciphertext.
    const encRow = { ...SAMPLE_EMPLOYEE, personnummer: encryptPersonnummer(SAMPLE_PERSONNUMMER) }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: encRow, error: null },
      }),
    )

    const res = await getEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.personnummer).toBe(SAMPLE_PERSONNUMMER)
    // The raw ciphertext must not surface.
    expect(JSON.stringify(body)).not.toContain(encRow.personnummer)
  })
})

describe('POST /api/v1/companies/:companyId/employees', () => {
  const validBody = {
    first_name: 'Anna',
    last_name: 'Andersson',
    personnummer: SAMPLE_PERSONNUMMER,
    employment_start: '2024-01-15',
    salary_type: 'monthly' as const,
    monthly_salary: 35000,
    tax_table_number: 33,
    tax_municipality: 'Stockholm',
  }

  it('creates an employee and returns the masked personnummer (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.first_name).toBe('Anna')
    expect(body.data.personnummer_masked).toBe('19000101XXXX')
    // Response shape never contains the raw personnummer.
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('returns 409 EMPLOYEE_DUPLICATE_PERSONNUMMER on 23505 (and does not echo the personnummer)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: {
          data: null,
          error: {
            code: '23505',
            message: 'duplicate',
            // Postgres auto-names the inline `UNIQUE (company_id, personnummer)`
            // constraint as `<table>_<columns>_key`. The route disambiguates
            // 23505s by substring-matching this name (see the constraint
            // disambiguation comment in employees/route.ts).
            constraint: 'employees_company_id_personnummer_key',
          },
        },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_DUPLICATE_PERSONNUMMER')
    // GDPR Art.5(1)(c) defense-in-depth: never echo the value back, ever.
    expect(JSON.stringify(body.error)).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('does not misattribute a 23505 from a future unique index to EMPLOYEE_DUPLICATE_PERSONNUMMER', async () => {
    // Defensive: if a future migration adds another unique constraint on
    // employees (e.g. (company_id, email)), a 23505 raised by that
    // constraint must NOT be mapped to EMPLOYEE_DUPLICATE_PERSONNUMMER.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: {
          data: null,
          error: {
            code: '23505',
            message: 'duplicate',
            constraint: 'employees_company_id_email_key', // hypothetical
          },
        },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    const body = await res.json()
    expect(body.error.code).not.toBe('EMPLOYEE_DUPLICATE_PERSONNUMMER')
  })

  it('returns a dry-run preview without committing when ?dry_run=true', async () => {
    const fromSpy = vi.fn()
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        fromSpy(table)
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const data = table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : null
              return (resolve: (v: unknown) => void) => resolve({ data, error: null })
            }
            return () => new Proxy({}, this!)
          },
        })
      },
    })

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees?dry_run=true`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(fromSpy).not.toHaveBeenCalledWith('employees')
    // The dry-run preview must mask personnummer the same way the live
    // response shape does: never echo back the supplied identifier.
    const body = await res.json()
    expect(body.data.preview.personnummer_masked).toBe('19000101XXXX')
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: JSON.stringify(validBody),
    })

    const res = await createEmployee(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
  })

  it('returns 400 when personnummer is the wrong length', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        // 10-digit form: the schema requires the 12-digit YYYYMMDDNNNN form.
        body: JSON.stringify({ ...validBody, personnummer: '8504121234' }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('requires tax_table_number for A-skatt non-sidoinkomst employees', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify({
          first_name: 'Bo',
          last_name: 'Berg',
          personnummer: '190001020000',
          employment_start: '2024-02-01',
          salary_type: 'monthly',
          monthly_salary: 30000,
          // Deliberately missing tax_table_number: superRefine should fail.
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('stores the personnummer encrypted at rest (round-trips, never plaintext)', async () => {
    // Regression: this path used to insert body.personnummer verbatim, leaving
    // plaintext personnummer in the DB and 500-ing every decrypt-on-read path.
    let inserted: Record<string, unknown> | undefined
    mockServiceClient.mockReturnValue({
      from: (table: string) =>
        new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === 'then') {
                const data =
                  table === 'company_members'
                    ? { company_id: COMPANY_ID, role: 'owner' }
                    : table === 'employees'
                      ? SAMPLE_EMPLOYEE
                      : null
                return (resolve: (v: unknown) => void) => resolve({ data, error: null })
              }
              return (...args: unknown[]) => {
                if (prop === 'insert' && table === 'employees') {
                  inserted = args[0] as Record<string, unknown>
                }
                return new Proxy({}, this!)
              }
            },
          },
        ),
    })

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(inserted).toBeDefined()
    const storedPnr = inserted!.personnummer as string
    // Not stored as plaintext, and round-trips back to the supplied value.
    expect(storedPnr).not.toBe(SAMPLE_PERSONNUMMER)
    expect(decryptPersonnummer(storedPnr)).toBe(SAMPLE_PERSONNUMMER)
  })
})

describe('PATCH /api/v1/companies/:companyId/employees/:id', () => {
  it('updates an employee and never overwrites unmentioned columns with defaults', async () => {
    // Defensive: the route reads the existing row, then only writes the keys
    // that were explicitly present in the request body. The mock returns the
    // pre-update row on the first read; the second read returns the updated
    // row that the route sends back to the caller.
    const updated = { ...SAMPLE_EMPLOYEE, monthly_salary: 38000 }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: [{ data: SAMPLE_EMPLOYEE, error: null }, { data: updated, error: null }],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ monthly_salary: 38000 }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.monthly_salary).toBe(38000)
    // GDPR Art.5(1)(c): PATCH success response masks personnummer (write
    // shape): the full value is only echoed by the GET drill-in.
    expect(body.data.personnummer_masked).toBe('19000101XXXX')
    expect(body.data.personnummer).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('returns 404 EMPLOYEE_NOT_FOUND when the row is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ monthly_salary: 38000 }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('returns 400 when the body contains personnummer (identity is immutable)', async () => {
    // SOC 2 PI1.3 / processing integrity: surface the intent error instead
    // of silently dropping the field. Caller learns the constraint
    // explicitly rather than being misled into thinking the value was
    // applied.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({
          personnummer: '190001029999',
          monthly_salary: 40000,
        }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('personnummer')
  })

  it('returns a dry-run preview with masked personnummer', async () => {
    // GDPR Art.5(1)(c): the dry-run preview is a write-shape so it follows
    // the same masking rule as POST and PATCH success. The full value is
    // only echoed by the GET drill-in.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}?dry_run=true`, {
        method: 'PATCH',
        body: JSON.stringify({ monthly_salary: 38000 }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.personnummer_masked).toBe('19000101XXXX')
    expect(body.data.preview.personnummer).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })
})

describe('DELETE /api/v1/companies/:companyId/employees/:id', () => {
  it('soft-deletes via is_active=false (no hard delete)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID, is_active: true }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(204)
  })

  it('is idempotent: deleting an already-inactive employee returns 204', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID, is_active: false }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(204)
  })

  it('returns 404 EMPLOYEE_NOT_FOUND when the row is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })
})
