/**
 * Tests for the v1 payslip line writes (payroll gap-closure 1.2).
 *
 * POST   /salary-runs/{id}/employees/{employeeId}/lines
 * PATCH  /salary-runs/{id}/lines/{lineId}
 * DELETE /salary-runs/{id}/lines/{lineId}
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `salary line route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as createLine } from '../../employees/[employeeId]/lines/route'
import { PATCH as patchLine, DELETE as deleteLine } from '../[lineId]/route'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const USER_ID = 'user-1'

const SAMPLE_LINE = {
  id: LINE_ID,
  salary_run_employee_id: SRE_ID,
  company_id: COMPANY_ID,
  item_type: 'bonus',
  description: 'Kvartalsbonus',
  quantity: null,
  unit_price: null,
  amount: 5000,
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: true,
  is_gross_deduction: false,
  is_net_deduction: false,
  account_number: '7210',
  sort_order: 0,
  created_at: '2026-05-01T08:00:00Z',
  updated_at: '2026-05-01T08:00:00Z',
}

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

function createParams(companyId: string, id: string, employeeId: string) {
  return { params: Promise.resolve({ companyId, id, employeeId }) }
}

function lineParams(companyId: string, id: string, lineId: string) {
  return { params: Promise.resolve({ companyId, id, lineId }) }
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

describe('POST /salary-runs/:id/employees/:employeeId/lines', () => {
  const validBody = { item_type: 'bonus', description: 'Kvartalsbonus', amount: 5000 }

  it('creates a line and returns 201 with the qualified id (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_run_employees: { data: { id: SRE_ID, employee_id: EMPLOYEE_ID }, error: null },
        salary_line_items: { data: SAMPLE_LINE, error: null },
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await createLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`,
        { method: 'POST', body: JSON.stringify(validBody) },
      ),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.salary_line_item_id).toBe(LINE_ID)
    expect(body.data.item_type).toBe('bonus')
    expect(body.data.id).toBeUndefined()
  })

  it('returns 400 SALARY_RUN_LINE_NOT_DRAFT when the run has advanced', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null },
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await createLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`,
        { method: 'POST', body: JSON.stringify(validBody) },
      ),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('review')
  })

  it('returns 404 SALARY_RUN_EMPLOYEE_NOT_FOUND when the employee is not in the run', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_run_employees: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await createLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`,
        { method: 'POST', body: JSON.stringify(validBody) },
      ),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_EMPLOYEE_NOT_FOUND')
  })

  it('rejects an unknown item_type with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await createLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`,
        { method: 'POST', body: JSON.stringify({ ...validBody, item_type: 'space_travel' }) },
      ),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns a dry-run preview without inserting', async () => {
    const supabaseMock = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
      salary_run_employees: { data: { id: SRE_ID, employee_id: EMPLOYEE_ID }, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock.supabase)

    const res = await createLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines?dry_run=true`,
        { method: 'POST', body: JSON.stringify({ ...validBody, amount: 1.005 }) },
      ),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.salary_line_item_id).toBeNull()
    // roundOre: 1.005 -> 1.01 (the exact-half case naive rounding gets wrong).
    expect(body.data.preview.amount).toBe(1.01)
    // No override given: the booking resolves the default.
    expect(body.data.preview.account_number).toBeNull()
    // No insert happened: salary_line_items was never touched.
    expect(supabaseMock.tables()).not.toContain('salary_line_items')
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
    )

    const req = new Request(
      `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test' },
        body: JSON.stringify(validBody),
      },
    )
    const res = await createLine(req, createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID))
    expect(res.status).toBe(400)
  })

  it('rejects keys without payroll:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'read-only',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)

    const res = await createLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`,
        { method: 'POST', body: JSON.stringify(validBody) },
      ),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)

    const res = await createLine(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`,
        { method: 'POST', body: JSON.stringify(validBody) },
      ),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(401)
  })
})

describe('PATCH /salary-runs/:id/lines/:lineId', () => {
  it('updates a line (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_line_items: [
          { data: { ...SAMPLE_LINE, salary_run_employee: { salary_run_id: RUN_ID } }, error: null },
          { data: { ...SAMPLE_LINE, amount: 5500 }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await patchLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/lines/${LINE_ID}`,
        { method: 'PATCH', body: JSON.stringify({ amount: 5500 }) },
      ),
      lineParams(COMPANY_ID, RUN_ID, LINE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.salary_line_item_id).toBe(LINE_ID)
    expect(body.data.amount).toBe(5500)
  })

  it('returns 404 SALARY_LINE_NOT_FOUND for a line from another run', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_line_items: {
          data: {
            ...SAMPLE_LINE,
            salary_run_employee: { salary_run_id: '99999999-9999-4999-8999-999999999999' },
          },
          error: null,
        },
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await patchLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/lines/${LINE_ID}`,
        { method: 'PATCH', body: JSON.stringify({ amount: 5500 }) },
      ),
      lineParams(COMPANY_ID, RUN_ID, LINE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_LINE_NOT_FOUND')
  })

  it('rejects an empty patch with 400', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await patchLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/lines/${LINE_ID}`,
        { method: 'PATCH', body: JSON.stringify({}) },
      ),
      lineParams(COMPANY_ID, RUN_ID, LINE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('DELETE /salary-runs/:id/lines/:lineId', () => {
  it('deletes a line and returns 204', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_line_items: [
          { data: { ...SAMPLE_LINE, salary_run_employee: { salary_run_id: RUN_ID } }, error: null },
          { data: null, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await deleteLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/lines/${LINE_ID}`,
        { method: 'DELETE' },
      ),
      lineParams(COMPANY_ID, RUN_ID, LINE_ID),
    )

    expect(res.status).toBe(204)
  })

  it('returns 400 SALARY_RUN_LINE_NOT_DRAFT once the run has advanced', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'booked' }, error: null },
        idempotency_keys: { data: null, error: null },
      }).supabase,
    )

    const res = await deleteLine(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/lines/${LINE_ID}`,
        { method: 'DELETE' },
      ),
      lineParams(COMPANY_ID, RUN_ID, LINE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
  })
})

// Text rows (item_type 'text', lib/salary/text-rows.ts) and the 0 kr rule
// every door shares (crm#1076).
describe('v1 payslip lines: text rows and 0 kr rows', () => {
  const owner = { company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }
  const idem = { idempotency_keys: { data: null, error: null } }
  const draftRun = { salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null } }
  const onRun = { salary_run_employees: { data: { id: SRE_ID, employee_id: EMPLOYEE_ID }, error: null } }

  const TEXT_LINE = {
    ...SAMPLE_LINE,
    item_type: 'text',
    description: 'Lön enligt kollektivavtal',
    amount: 0,
    is_taxable: false,
    is_avgift_basis: false,
    is_vacation_basis: false,
    account_number: null,
    sort_order: 5,
  }

  const createUrl = `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}/lines`
  const lineUrl = `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/lines/${LINE_ID}`
  const textBody = { item_type: 'text', description: 'Lön enligt kollektivavtal' }

  async function create(tables: Parameters<typeof createTableMockSupabase>[0], body: unknown) {
    const mock = createTableMockSupabase(tables)
    mockServiceClient.mockReturnValue(mock.supabase)
    const res = await createLine(
      makeRequest(createUrl, { method: 'POST', body: JSON.stringify(body) }),
      createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    return { res, body: await res.json(), mock }
  }

  async function update(tables: Parameters<typeof createTableMockSupabase>[0], body: unknown) {
    const mock = createTableMockSupabase(tables)
    mockServiceClient.mockReturnValue(mock.supabase)
    const res = await patchLine(
      makeRequest(lineUrl, { method: 'PATCH', body: JSON.stringify(body) }),
      lineParams(COMPANY_ID, RUN_ID, LINE_ID),
    )
    return { res, body: await res.json(), mock }
  }

  describe('POST /salary-runs/:id/employees/:employeeId/lines', () => {
    it('creates a text row with no amount and returns 201', async () => {
      const { res, body, mock } = await create(
        { ...owner, ...idem, ...draftRun, ...onRun, salary_line_items: { data: TEXT_LINE, error: null } },
        { ...textBody, is_taxable: true },
      )

      expect(res.status).toBe(201)
      expect(body.data).toMatchObject({ salary_line_item_id: LINE_ID, item_type: 'text', amount: 0, account_number: null })
      expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
        item_type: 'text',
        description: 'Lön enligt kollektivavtal',
        quantity: null,
        unit_price: null,
        amount: 0,
        account_number: null,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
      })
    })

    it('previews a text row on dry_run without writing', async () => {
      const mock = createTableMockSupabase({ ...owner, ...idem, ...draftRun, ...onRun })
      mockServiceClient.mockReturnValue(mock.supabase)
      const res = await createLine(
        makeRequest(`${createUrl}?dry_run=true`, { method: 'POST', body: JSON.stringify(textBody) }),
        createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.preview).toMatchObject({ salary_line_item_id: null, item_type: 'text', amount: 0, account_number: null })
      expect(mock.tables()).not.toContain('salary_line_items')
    })

    it('returns 400 VALIDATION_ERROR for a text row with an amount', async () => {
      const { res, body, mock } = await create({ ...owner, ...idem, ...draftRun, ...onRun }, { ...textBody, amount: 500 })
      expect(res.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details).toMatchObject({
        field: 'amount',
        message: 'En textrad har inget belopp. Lägg beloppet på en egen rad.',
      })
      expect(mock.tables()).not.toContain('salary_line_items')
    })

    it('returns 400 VALIDATION_ERROR for a 0 kr money row and a money row without an amount', async () => {
      for (const body of [
        { item_type: 'bonus', description: 'Bonus', amount: 0 },
        { item_type: 'bonus', description: 'Bonus' },
      ]) {
        const { res, body: json, mock } = await create({ ...owner, ...idem, ...draftRun, ...onRun }, body)
        expect(res.status).toBe(400)
        expect(json.error.code).toBe('VALIDATION_ERROR')
        expect(json.error.details.field).toBe('amount')
        expect(json.error.details.message).toMatch(/inte är 0 kr/)
        expect(mock.tables()).not.toContain('salary_line_items')
      }
    })

    it('returns 400 VALIDATION_ERROR for a wrong sign', async () => {
      for (const body of [
        { item_type: 'gross_deduction_other', description: 'Avdrag', amount: 1000 },
        { item_type: 'mileage_taxfree', description: 'Mil', amount: -300 },
        { item_type: 'benefit_other', description: 'Förmån', amount: -100 },
      ]) {
        const { res, body: json, mock } = await create({ ...owner, ...idem, ...draftRun, ...onRun }, body)
        expect(res.status).toBe(400)
        expect(json.error.code).toBe('VALIDATION_ERROR')
        expect(json.error.details.field).toBe('amount')
        expect(mock.tables()).not.toContain('salary_line_items')
      }
    })

    it('creates a vacation line that carries only its days, as the docs say (crm#1331)', async () => {
      const VACATION_LINE = { ...SAMPLE_LINE, item_type: 'vacation', description: 'Semester', quantity: 5, amount: 0 }
      const { res, body, mock } = await create(
        { ...owner, ...idem, ...draftRun, ...onRun, salary_line_items: { data: VACATION_LINE, error: null } },
        { item_type: 'vacation', description: 'Semester', quantity: 5 },
      )
      expect(res.status).toBe(201)
      expect(body.data).toMatchObject({ item_type: 'vacation', quantity: 5, amount: 0 })
      expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({ item_type: 'vacation', quantity: 5, amount: 0 })
    })

    it('returns 400 VALIDATION_ERROR for a vacation line with neither days nor an amount', async () => {
      const { res, body, mock } = await create(
        { ...owner, ...idem, ...draftRun, ...onRun },
        { item_type: 'vacation', description: 'Semester' },
      )
      expect(res.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details.field).toBe('quantity')
      expect(mock.tables()).not.toContain('salary_line_items')
    })

    it('returns 404 SALARY_RUN_NOT_FOUND for an unknown run', async () => {
      const { res, body } = await create(
        { ...owner, ...idem, salary_runs: { data: null, error: null } },
        textBody,
      )
      expect(res.status).toBe(404)
      expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
    })

    it('returns 404 SALARY_RUN_EMPLOYEE_NOT_FOUND for an employee not on the run', async () => {
      const { res, body } = await create(
        { ...owner, ...idem, ...draftRun, salary_run_employees: { data: null, error: null } },
        textBody,
      )
      expect(res.status).toBe(404)
      expect(body.error.code).toBe('SALARY_RUN_EMPLOYEE_NOT_FOUND')
    })

    it('returns 401 for a text row without a bearer token', async () => {
      mockValidate.mockResolvedValue(null)
      mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)
      const res = await createLine(
        new Request(createUrl, { method: 'POST', body: JSON.stringify(textBody) }),
        createParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
      )
      expect(res.status).toBe(401)
    })
  })

  describe('PATCH /salary-runs/:id/lines/:lineId', () => {
    const storedText = { data: { ...TEXT_LINE, salary_run_employee: { salary_run_id: RUN_ID } }, error: null }

    it('updates the words of a text row and returns 200', async () => {
      const { res, body, mock } = await update(
        {
          ...owner,
          ...idem,
          ...draftRun,
          salary_line_items: [storedText, { data: { ...TEXT_LINE, description: 'Ny text' }, error: null }],
        },
        { description: 'Ny text' },
      )
      expect(res.status).toBe(200)
      expect(body.data).toMatchObject({ salary_line_item_id: LINE_ID, description: 'Ny text', amount: 0 })
      expect(mock.findCall('salary_line_items', 'update')?.[0]).toMatchObject({
        description: 'Ny text',
        account_number: null,
        is_taxable: false,
      })
    })

    it('returns 400 VALIDATION_ERROR for an amount on a text row', async () => {
      const { res, body, mock } = await update(
        { ...owner, ...idem, ...draftRun, salary_line_items: [storedText] },
        { amount: 250 },
      )
      expect(res.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details.field).toBe('amount')
      expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
    })

    it('returns 400 VALIDATION_ERROR when a money row is patched to 0 kr', async () => {
      const { res, body, mock } = await update(
        {
          ...owner,
          ...idem,
          ...draftRun,
          salary_line_items: [{ data: { ...SAMPLE_LINE, salary_run_employee: { salary_run_id: RUN_ID } }, error: null }],
        },
        { amount: 0 },
      )
      expect(res.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details.message).toMatch(/inte är 0 kr/)
      expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
    })

    it('returns 404 SALARY_RUN_NOT_FOUND for an unknown run', async () => {
      const { res, body } = await update(
        { ...owner, ...idem, salary_runs: { data: null, error: null } },
        { description: 'Ny text' },
      )
      expect(res.status).toBe(404)
      expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
    })

    it('returns 401 without a bearer token', async () => {
      mockValidate.mockResolvedValue(null)
      mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)
      const res = await patchLine(
        new Request(lineUrl, { method: 'PATCH', body: JSON.stringify({ description: 'Ny text' }) }),
        lineParams(COMPANY_ID, RUN_ID, LINE_ID),
      )
      expect(res.status).toBe(401)
    })
  })
})
