/**
 * Integration tests for the v1 employees vertical (Phase 5 PR-1).
 *
 * Covers list / detail / create / patch / delete on /employees.
 * Mirrors the Phase 4 suppliers test pattern: Proxy-backed Supabase mock
 * returns per-table responses; each suite focuses on outcome (status + body
 * shape) rather than query mechanics.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JAMKNING_END_REQUIRED, JAMKNING_ROW_INCOMPLETE } from '@/lib/salary/jamkning-rules'

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
  // Payloads handed to `.update()`, per table: what a PATCH actually writes.
  const updates: Record<string, unknown[]> = {}
  // Payloads handed to `.insert()` and `.eq()` filters, per table.
  const inserts: Record<string, unknown[]> = {}
  const eqs: Record<string, unknown[][]> = {}
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
        return (...args: unknown[]) => {
          if (prop === 'update') (updates[table] ??= []).push(args[0])
          if (prop === 'insert') (inserts[table] ??= []).push(args[0])
          if (prop === 'eq') (eqs[table] ??= []).push(args)
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { updates, inserts, eqs, from: vi.fn((table: string) => buildChain(table)) }
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
// while being obviously not a real birthdate (year 1900, day 1, near-zero
// suffix). ISO A.5.34 / GDPR Art.5(1)(c): test fixtures must not look like
// production-format PII. The last digit is the Luhn check digit for this
// otherwise-zero suffix: the create route now enforces the checksum, so a
// fixture ending '0000' would be rejected before it reached the insert.
const SAMPLE_PERSONNUMMER = '190001010008'

const SAMPLE_EMPLOYEE = {
  id: EMPLOYEE_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer: SAMPLE_PERSONNUMMER,
  employment_type: 'employee',
  personnel_category: 'tjansteman',
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
  jamkning_percentage: null,
  jamkning_valid_from: null,
  jamkning_valid_to: null,
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
    expect(body.data[0].personnummer_masked).toBe('19000101-XXXX')
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
    // mask is YYYYMMDD-XXXX (not fully redacted). Neither the ciphertext nor
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
    expect(body.data[0].personnummer_masked).toBe('19000101-XXXX')
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

  it('refuses to put an enskild firma\'s owner on payroll with VALIDATION_ERROR on employment_type, like the dashboard and MCP (#782)', async () => {
    // The v1 PATCH used to skip this rule; the database trigger then refused
    // the write with a 500.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ employment_type: 'company_owner' }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('employment_type')
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
    expect(body.data.personnummer_masked).toBe('19000101-XXXX')
    // Response shape never contains the raw personnummer.
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('rejects a jämkning percentage without an end date (#2058)', async () => {
    // The engine applies a beslut only when BOTH dates are set; the API used
    // to accept this shape and store an inert beslut.
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
        body: JSON.stringify({
          ...validBody,
          jamkning_percentage: 15,
          jamkning_valid_from: '2026-01-01',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify(body.error)).toContain('jamkning_valid_to')
  })

  it('accepts a complete jämkning beslut on create', async () => {
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
        body: JSON.stringify({
          ...validBody,
          jamkning_percentage: 15,
          jamkning_valid_from: '2026-01-01',
          jamkning_valid_to: '2026-12-31',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
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
    expect(body.data.preview.personnummer_masked).toBe('19000101-XXXX')
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

  it('returns 400 for a check-digit-invalid personnummer (matches the dashboard surface)', async () => {
    // The schema only checks `^\d{12}$`, so before this guard a transposed or
    // mistyped digit entered payroll here and only surfaced weeks later as a
    // rejected arbetsgivardeklaration from Skatteverket. '190001010001' has a
    // valid date but the wrong Luhn check digit (the correct one is 8).
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify({ ...validBody, personnummer: '190001010001' }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('personnummer')
    // GDPR Art.5(1)(c): the rejection must not echo the supplied number back.
    expect(JSON.stringify(body)).not.toContain('190001010001')
  })

  it('accepts a samordningsnummer (day carries +60), same as the AGI generator', async () => {
    // A samordningsnummer holder can be filed for under FK215, so registering
    // one as an employee must work on this surface too. '19000161' is day
    // 01 + 60; '5' is the matching Luhn check digit.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
      }),
    )

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify({ ...validBody, personnummer: '190001610005' }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).not.toBe(400)
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
          personnummer: '190001020007',
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
    expect(body.data.personnummer_masked).toBe('19000101-XXXX')
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

  it('sets work-schedule fields (arbetsschema-lite)', async () => {
    const updated = { ...SAMPLE_EMPLOYEE, hours_per_week: 32, workdays_per_week: 4 }
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
        body: JSON.stringify({ hours_per_week: 32, workdays_per_week: 4 }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.hours_per_week).toBe(32)
    expect(body.data.workdays_per_week).toBe(4)
  })

  it('rejects an out-of-range work schedule', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ workdays_per_week: 9 }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('sets jämkning fields (percentage + validity window)', async () => {
    const updated = {
      ...SAMPLE_EMPLOYEE,
      jamkning_percentage: 15,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: '2026-12-31',
    }
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
        body: JSON.stringify({
          jamkning_percentage: 15,
          jamkning_valid_from: '2026-01-01',
          jamkning_valid_to: '2026-12-31',
        }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.jamkning_percentage).toBe(15)
    expect(body.data.jamkning_valid_from).toBe('2026-01-01')
  })

  it('rejects a jämkning percentage without a start date (merged state)', async () => {
    // Existing row has no jamkning_valid_from; sending only the percentage
    // must fail the route-level merged-state check.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ jamkning_percentage: 15 }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('jamkning_valid_from')
  })

  it('rejects a jämkning percentage without an end date (merged state, #2058)', async () => {
    // Percentage + start date only: the engine would never apply it, so the
    // route must refuse rather than store an inert beslut.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ jamkning_percentage: 15, jamkning_valid_from: '2026-01-01' }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('jamkning_valid_to')
    expect(body.error.details.message).toContain('slutdatum')
  })

  it('rejects clearing only the end date of a stored beslut', async () => {
    const withJamkning = {
      ...SAMPLE_EMPLOYEE,
      jamkning_percentage: 15,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: '2026-12-31',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: withJamkning, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ jamkning_valid_to: null }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.field).toBe('jamkning_valid_to')
  })

  // The PostgREST error for employees_jamkning_dates_check (#2256), as
  // observed against a real PostgREST: the constraint name is in `message`,
  // `details` carries the failing row and must never reach the response.
  const CHECK_CONSTRAINT_ERROR = {
    code: '23514',
    message: 'new row for relation "employees" violates check constraint "employees_jamkning_dates_check"',
    details: 'Failing row contains (...).',
    hint: null,
  }

  it('answers the CHECK constraint (concurrent-PATCH race, #2256) as the same VALIDATION_ERROR', async () => {
    // The snapshot was empty, so a percentage with both dates passes the
    // merged check; another request changed the row in between and the
    // constraint refused the write. The merged row cannot explain it, so the
    // umbrella sentence is used.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: [
          { data: SAMPLE_EMPLOYEE, error: null },
          { data: null, error: CHECK_CONSTRAINT_ERROR },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({
          jamkning_percentage: 15,
          jamkning_valid_from: '2026-01-01',
          jamkning_valid_to: '2026-12-31',
        }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('jamkning_valid_to')
    expect(body.error.details.message).toBe(`${JAMKNING_ROW_INCOMPLETE}.`)
    expect(JSON.stringify(body)).not.toContain('violates check constraint')
    expect(JSON.stringify(body)).not.toContain('Failing row')
  })

  it('names the missing date when a legacy incomplete row is edited in an unrelated column (NOT VALID trade-off)', async () => {
    // The route lets the unrelated edit through (touched gate); the
    // constraint refuses the row on its next UPDATE, and the merged row
    // explains exactly what to complete.
    const legacy = {
      ...SAMPLE_EMPLOYEE,
      jamkning_percentage: 15,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: null,
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: [
          { data: legacy, error: null },
          { data: null, error: CHECK_CONSTRAINT_ERROR },
        ],
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

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('jamkning_valid_to')
    expect(body.error.details.message).toBe(`${JAMKNING_END_REQUIRED}. Skicka även \`jamkning_valid_to\` i samma PATCH.`)
  })

  it('leaves a legacy row without valid_to editable in unrelated ways (touched gate)', async () => {
    const legacy = {
      ...SAMPLE_EMPLOYEE,
      jamkning_percentage: 15,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: null,
    }
    const updated = { ...legacy, monthly_salary: 38000 }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: [{ data: legacy, error: null }, { data: updated, error: null }],
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
  })

  it('rejects jamkning_valid_to before jamkning_valid_from', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({
          jamkning_percentage: 15,
          jamkning_valid_from: '2026-06-01',
          jamkning_valid_to: '2026-01-01',
        }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('clears the jämkningsbeslut with an explicit null', async () => {
    const withJamkning = {
      ...SAMPLE_EMPLOYEE,
      jamkning_percentage: 15,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: null,
    }
    const cleared = { ...SAMPLE_EMPLOYEE }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: [{ data: withJamkning, error: null }, { data: cleared, error: null }],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ jamkning_percentage: null }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.jamkning_percentage).toBeNull()
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
    expect(body.data.preview.personnummer_masked).toBe('19000101-XXXX')
    expect(body.data.preview.personnummer).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
  })
})

/**
 * The update contract (#3008), the same one the dashboard PATCH and the MCP
 * update_employee tool honour: an explicit null clears a nullable column, an
 * absent key leaves it unchanged, and the merged row must stay valid.
 */
describe('PATCH /api/v1/companies/:companyId/employees/:id clearing fields (#3008)', () => {
  const ENDED = { ...SAMPLE_EMPLOYEE, employment_end: '2026-06-30' }
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`

  function patch(body: Record<string, unknown>) {
    return updateEmployee(
      makeRequest(url, { method: 'PATCH', body: JSON.stringify(body) }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
  }

  function useRows(existing: Record<string, unknown>, updated: Record<string, unknown> = existing) {
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: [{ data: existing, error: null }, { data: updated, error: null }],
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)
    return mock.updates
  }

  it('clears the slutdatum with an explicit null and writes only that key', async () => {
    const updates = useRows(ENDED, { ...ENDED, employment_end: null })

    const res = await patch({ employment_end: null })

    expect(res.status).toBe(200)
    expect(updates.employees).toEqual([{ employment_end: null }])
    const body = await res.json()
    expect(body.data.employment_end).toBeNull()
  })

  it('previews a cleared field under ?dry_run=true without writing', async () => {
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: ENDED, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)

    const res = await updateEmployee(
      makeRequest(`${url}?dry_run=true`, { method: 'PATCH', body: JSON.stringify({ employment_end: null }) }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.employment_end).toBeNull()
    expect(mock.updates.employees).toBeUndefined()
  })

  it('returns 400 VALIDATION_ERROR for null on a NOT NULL column', async () => {
    const updates = useRows(ENDED)

    const res = await patch({ employment_start: null })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(updates.employees).toBeUndefined()
  })

  it('returns 400 VALIDATION_ERROR when clearing the monthly salary of a monthly employee', async () => {
    const updates = useRows(ENDED)

    const res = await patch({ monthly_salary: null })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('monthly_salary')
    expect(updates.employees).toBeUndefined()
  })

  it('returns 400 VALIDATION_ERROR when clearing the tax table of an A-skatt employee', async () => {
    const updates = useRows(ENDED)

    const res = await patch({ tax_table_number: null })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.field).toBe('tax_table_number')
    expect(updates.employees).toBeUndefined()
  })

  it('returns 400 VALIDATION_ERROR when clearing the Växa-stöd start while the flag stays on', async () => {
    const updates = useRows({ ...ENDED, vaxa_stod_eligible: true, vaxa_stod_start: '2026-01-01' })

    const res = await patch({ vaxa_stod_start: null })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.field).toBe('vaxa_stod_start')
    expect(body.error.details.message).toBe(
      'Startdatum för Växa-stöd måste anges när Växa-stöd är aktiverat. Skicka även `vaxa_stod_start` i samma PATCH.',
    )
    expect(updates.employees).toBeUndefined()
  })

  it('clears both bank fields, but refuses clearing only one (both-or-neither)', async () => {
    const both = useRows(ENDED, { ...ENDED, clearing_number: null, bank_account_number: null })
    const resBoth = await patch({ clearing_number: null, bank_account_number: null })
    expect(resBoth.status).toBe(200)
    expect(both.employees).toEqual([{ clearing_number: null, bank_account_number: null }])

    const one = useRows(ENDED)
    const resOne = await patch({ clearing_number: null })
    expect(resOne.status).toBe(400)
    const body = await resOne.json()
    expect(body.error.details.field).toBe('clearing_number')
    expect(one.employees).toBeUndefined()
  })
})

/**
 * is_active on PATCH (crm#1133). The DELETE docs and the MCP tool both named
 * PATCH is_active=true as the way back from a soft delete, but the key was
 * missing from UpdateEmployeeSchema: Zod stripped it and the PATCH answered
 * 200 with the employee still inactive. true reactivates; false is the write
 * DELETE makes.
 */
describe('PATCH /api/v1/companies/:companyId/employees/:id is_active (crm#1133)', () => {
  const INACTIVE = { ...SAMPLE_EMPLOYEE, is_active: false }
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`

  function patch(body: Record<string, unknown>, query = '') {
    return updateEmployee(
      makeRequest(`${url}${query}`, { method: 'PATCH', body: JSON.stringify(body) }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
  }

  function useRows(existing: Record<string, unknown> | null, updated: Record<string, unknown> | null = existing) {
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: [{ data: existing, error: null }, { data: updated, error: null }],
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)
    return mock.updates
  }

  it('reactivates an inactive employee: writes is_active true and nothing else', async () => {
    const updates = useRows(INACTIVE, { ...INACTIVE, is_active: true })

    const res = await patch({ is_active: true })

    expect(res.status).toBe(200)
    expect(updates.employees).toEqual([{ is_active: true }])
    const body = await res.json()
    expect(body.data.is_active).toBe(true)
    // Write shape: the personnummer stays masked, as on every other PATCH.
    expect(body.data.personnummer_masked).toBe('19000101-XXXX')
    expect(body.data.personnummer).toBeUndefined()
  })

  it('deactivates an active employee: the same single-column write DELETE makes', async () => {
    const updates = useRows(SAMPLE_EMPLOYEE, INACTIVE)

    const res = await patch({ is_active: false })

    expect(res.status).toBe(200)
    expect(updates.employees).toEqual([{ is_active: false }])
    const body = await res.json()
    expect(body.data.is_active).toBe(false)
  })

  it('writes the flag together with an unrelated field in the same PATCH', async () => {
    const updates = useRows(INACTIVE, { ...INACTIVE, is_active: true, phone: '0700000000' })

    const res = await patch({ is_active: true, phone: '0700000000' })

    expect(res.status).toBe(200)
    expect(updates.employees).toEqual([{ is_active: true, phone: '0700000000' }])
  })

  it('still saves an unrelated field on its own and leaves the flag out of the write', async () => {
    const updates = useRows(INACTIVE, { ...INACTIVE, phone: '0700000000' })

    const res = await patch({ phone: '0700000000' })

    expect(res.status).toBe(200)
    expect(updates.employees).toEqual([{ phone: '0700000000' }])
    const body = await res.json()
    expect(body.data.phone).toBe('0700000000')
    expect(body.data.is_active).toBe(false)
  })

  it('previews the reactivation under ?dry_run=true and writes nothing', async () => {
    const updates = useRows(INACTIVE)

    const res = await patch({ is_active: true }, '?dry_run=true')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.is_active).toBe(true)
    expect(updates.employees).toBeUndefined()
  })

  it('returns 400 VALIDATION_ERROR naming is_active for a value that is not a boolean, and writes nothing', async () => {
    const updates = useRows(INACTIVE)

    for (const value of [null, 'true', 1]) {
      const res = await patch({ is_active: value })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(JSON.stringify(body.error.details)).toContain('is_active')
    }
    expect(updates.employees).toBeUndefined()
  })

  it('returns 404 EMPLOYEE_NOT_FOUND when the row is missing, and writes nothing', async () => {
    const updates = useRows(null)

    const res = await patch({ is_active: true })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
    expect(updates.employees).toBeUndefined()
  })

  it('returns 401 UNAUTHORIZED for a key that does not validate, and writes nothing', async () => {
    const updates = useRows(INACTIVE)
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const res = await patch({ is_active: true })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(updates.employees).toBeUndefined()
  })

  it('returns 403 INSUFFICIENT_SCOPE without payroll:write, and writes nothing', async () => {
    const updates = useRows(INACTIVE)
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'read only',
      scopes: ['payroll:read'],
      mode: 'live',
    })

    const res = await patch({ is_active: true })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(updates.employees).toBeUndefined()
  })

  it('answers the jämkning CHECK refusal of a legacy incomplete row as a 400, not a 500', async () => {
    // employees_jamkning_dates_check is NOT VALID: it is checked on the row's
    // next UPDATE whatever column it names, the reactivation included.
    const legacy = { ...INACTIVE, jamkning_percentage: 15, jamkning_valid_from: '2026-01-01', jamkning_valid_to: null }
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: [
        { data: legacy, error: null },
        {
          data: null,
          error: {
            code: '23514',
            message: 'new row for relation "employees" violates check constraint "employees_jamkning_dates_check"',
          },
        },
      ],
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)

    const res = await patch({ is_active: true })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('jamkning_valid_to')
    expect(body.error.details.message).toContain(JAMKNING_END_REQUIRED)
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

  // The rule moved to lib/salary/employee-soft-delete.ts (shared with MCP):
  // the wire behaviour is pinned here so the move cannot change it.
  const ROW = { id: EMPLOYEE_ID, first_name: 'Anna', last_name: 'Andersson', is_active: true }

  it('writes is_active=false and nothing else', async () => {
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: ROW, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)

    const res = await deleteEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(204)
    expect(mock.updates.employees).toEqual([{ is_active: false }])
  })

  it('does not write for an employee who is already inactive', async () => {
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: { ...ROW, is_active: false }, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)

    const res = await deleteEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(204)
    expect(mock.updates.employees).toBeUndefined()
  })

  it('previews { id, is_active: false } under ?dry_run=true and writes nothing', async () => {
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: ROW, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)

    const res = await deleteEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}?dry_run=true`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ dry_run: true, preview: { id: EMPLOYEE_ID, is_active: false } })
    expect(mock.updates.employees).toBeUndefined()
  })
})

describe('förhöjt skatteavdrag on the v1 employee doors', () => {
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`
  const NONE = { ...SAMPLE_EMPLOYEE, extra_tax_amount: null, extra_tax_percentage: null }

  function patch(body: Record<string, unknown>) {
    return updateEmployee(
      makeRequest(url, { method: 'PATCH', body: JSON.stringify(body) }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
  }

  function useRows(existing: Record<string, unknown> | null, updated: Record<string, unknown> | null = existing) {
    const mock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: [{ data: existing, error: null }, { data: updated, error: null }],
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(mock)
    return mock.updates
  }

  it('401 for a key that does not validate, and writes nothing', async () => {
    const updates = useRows(NONE)
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const res = await patch({ extra_tax_percentage: 45 })

    expect(res.status).toBe(401)
    expect(updates.employees).toBeUndefined()
  })

  it.each([
    ['both forms at once', { extra_tax_amount: 500, extra_tax_percentage: 45 }],
    ['fractional kronor', { extra_tax_amount: 500.5 }],
    ['101 %', { extra_tax_percentage: 101 }],
  ])('400 VALIDATION_ERROR for %s, and writes nothing', async (_name, body) => {
    const updates = useRows(NONE)

    const res = await patch(body)

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(updates.employees).toBeUndefined()
  })

  it('400 when a percentage is sent while kronor are stored', async () => {
    const updates = useRows({ ...NONE, extra_tax_amount: 500 })

    const res = await patch({ extra_tax_percentage: 45 })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify(body.error)).toContain('extra_tax_percentage')
    expect(updates.employees).toBeUndefined()
  })

  it('404 EMPLOYEE_NOT_FOUND when the row is missing', async () => {
    const updates = useRows(null)

    const res = await patch({ extra_tax_percentage: 45 })

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('EMPLOYEE_NOT_FOUND')
    expect(updates.employees).toBeUndefined()
  })

  it('200 and writes only the percentage (happy path)', async () => {
    const updates = useRows(NONE, { ...NONE, extra_tax_percentage: 45 })

    const res = await patch({ extra_tax_percentage: 45 })

    expect(res.status).toBe(200)
    expect(updates.employees).toEqual([{ extra_tax_percentage: 45 }])
    expect((await res.json()).data.extra_tax_percentage).toBe(45)
  })

  it('400 on create with both forms', async () => {
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
        body: JSON.stringify({
          first_name: 'Anna',
          last_name: 'Andersson',
          personnummer: SAMPLE_PERSONNUMMER,
          employment_start: '2024-01-15',
          salary_type: 'monthly',
          monthly_salary: 35000,
          tax_table_number: 33,
          tax_municipality: 'Stockholm',
          extra_tax_amount: 500,
          extra_tax_percentage: 45,
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    expect(JSON.stringify((await res.json()).error)).toContain('extra_tax_percentage')
  })
})

describe('personnel_category on the v1 employees doors', () => {
  const createBody = {
    first_name: 'Anna',
    last_name: 'Andersson',
    personnummer: SAMPLE_PERSONNUMMER,
    employment_start: '2024-01-15',
    salary_type: 'monthly' as const,
    monthly_salary: 35000,
    tax_table_number: 33,
    tax_municipality: 'Stockholm',
  }

  it('lists the category and filters on it', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: [{ ...SAMPLE_EMPLOYEE, personnel_category: 'arbetare' }], error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await listEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees?personnel_category=arbetare`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].personnel_category).toBe('arbetare')
    expect(supabase.eqs.employees).toContainEqual(['personnel_category', 'arbetare'])
  })

  it('rejects an unknown category filter with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: [], error: null },
      }),
    )
    const res = await listEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees?personnel_category=kollektiv`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns the category on the detail endpoint', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { ...SAMPLE_EMPLOYEE, personnel_category: 'arbetare' }, error: null },
      }),
    )
    const res = await getEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.personnel_category).toBe('arbetare')
  })

  it('creates a tjänsteman when the category is left out', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: SAMPLE_EMPLOYEE, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify(createBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(supabase.inserts.employees?.[0]).toMatchObject({ personnel_category: 'tjansteman' })
  })

  it('creates an arbetare', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: { ...SAMPLE_EMPLOYEE, personnel_category: 'arbetare' }, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify({ ...createBody, personnel_category: 'arbetare' }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(supabase.inserts.employees?.[0]).toMatchObject({ personnel_category: 'arbetare' })
    expect((await res.json()).data.personnel_category).toBe('arbetare')
  })

  it('rejects an unknown category on create with 400 and inserts nothing', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await createEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees`, {
        method: 'POST',
        body: JSON.stringify({ ...createBody, personnel_category: 'kollektiv' }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    expect(supabase.inserts.employees).toBeUndefined()
  })

  it('changes the category with a PATCH that writes only that key', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: [
        { data: SAMPLE_EMPLOYEE, error: null },
        { data: { ...SAMPLE_EMPLOYEE, personnel_category: 'arbetare' }, error: null },
      ],
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ personnel_category: 'arbetare' }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(supabase.updates.employees).toEqual([{ personnel_category: 'arbetare' }])
    expect((await res.json()).data.personnel_category).toBe('arbetare')
  })

  it('refuses null on the category (NOT NULL) with 400 and writes nothing', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: SAMPLE_EMPLOYEE, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ personnel_category: null }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    expect(supabase.updates.employees).toBeUndefined()
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for a category change on a missing employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateEmployee(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ personnel_category: 'arbetare' }),
      }),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('returns 401 for a key that does not validate', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await listEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees?personnel_category=arbetare`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(401)
  })
})
