import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const mockUser = { id: 'user-1', email: 'test@test.se' }
const SRE_UUID = '22222222-2222-4222-8222-222222222222'

function authed() {
  const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany, findCall }
}

const validBody = {
  salary_run_employee_id: SRE_UUID,
  item_type: 'bonus',
  description: 'Bonus',
  amount: 5000,
}

describe('POST /api/salary/runs/[id]/lines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('creates a line item on a draft run and returns 201', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      { data: { id: SRE_UUID, employee_id: 'emp-1' } }, // salary_run_employees membership
      { data: { id: 'li-1' } }, // insert line item
    ])

    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'run-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('li-1')
  })

  it('stores the flags of the type, whatever the body says (agent feedback seq 947288)', async () => {
    const { enqueueMany, findCall } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: SRE_UUID, employee_id: 'emp-1' } },
      { data: { id: 'li-2' } },
    ])

    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/lines', {
        method: 'POST',
        body: { ...validBody, item_type: 'benefit_meals', description: 'Kostförmån', amount: 500, is_avgift_basis: false },
      }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(201)
    expect(findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
    })
  })
})

// Text rows (item_type 'text', lib/salary/text-rows.ts) and the 0 kr rule
// every door shares (crm#1076).
describe('POST /api/salary/runs/[id]/lines: text rows and 0 kr rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  function authedWithCalls() {
    const mock = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mock.supabase as never,
      error: null,
    })
    return mock
  }

  const textBody = {
    salary_run_employee_id: SRE_UUID,
    item_type: 'text',
    description: 'Lön enligt kollektivavtal',
  }

  async function post(body: unknown) {
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body }),
      createMockRouteParams({ id: 'run-1' }),
    )
    return parseJsonResponse<{ data?: { id: string }; error?: string; code?: string }>(response)
  }

  it('returns 401 for a text row when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await post(textBody)
    expect(status).toBe(401)
  })

  it('creates a text row with no amount: words only, amount 0, no account, every flag false (201)', async () => {
    const { enqueueMany, findCall } = authedWithCalls()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: SRE_UUID, employee_id: 'emp-1' } },
      { data: { id: 'li-text' } },
    ])

    // Schema defaults (is_taxable true, ...) and a caller-sent account never
    // reach the stored row; a pasted line break collapses to one space.
    const { status, body } = await post({ ...textBody, description: '  Lön enligt\n  kollektivavtal  ', account_number: '7210' })

    expect(status).toBe(201)
    expect(body.data?.id).toBe('li-text')
    expect(findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      salary_run_employee_id: SRE_UUID,
      company_id: 'company-1',
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

  it('accepts an explicit 0 kr amount on a text row', async () => {
    const { enqueueMany } = authedWithCalls()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: SRE_UUID, employee_id: 'emp-1' } },
      { data: { id: 'li-text' } },
    ])
    const { status } = await post({ ...textBody, amount: 0 })
    expect(status).toBe(201)
  })

  it('returns 400 for a text row with an amount, and writes nothing', async () => {
    const { enqueueMany, findCall } = authedWithCalls()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: SRE_UUID, employee_id: 'emp-1' } },
    ])
    const { status, body } = await post({ ...textBody, amount: 500 })
    expect(status).toBe(400)
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toBe('En textrad har inget belopp. Lägg beloppet på en egen rad.')
    expect(findCall('salary_line_items', 'insert')).toBeUndefined()
  })

  it('returns 400 for a text row with a quantity or no words', async () => {
    for (const [extra, message] of [
      [{ quantity: 2 }, 'En textrad har inget antal eller á-pris.'],
      [{ description: '  \n ' }, 'En textrad måste ha en text.'],
    ] as const) {
      const { enqueueMany } = authedWithCalls()
      enqueueMany([
        { data: { id: 'run-1', status: 'draft' } },
        { data: { id: SRE_UUID, employee_id: 'emp-1' } },
      ])
      const { status, body } = await post({ ...textBody, ...extra })
      expect(status).toBe(400)
      expect(body.error).toBe(message)
    }
  })

  it('returns 400 for a 0 kr money row and for a money row without an amount', async () => {
    for (const amount of [0, 0.004, undefined]) {
      const { enqueueMany, findCall } = authedWithCalls()
      enqueueMany([
        { data: { id: 'run-1', status: 'draft' } },
        { data: { id: SRE_UUID, employee_id: 'emp-1' } },
      ])
      const { status, body } = await post({ ...validBody, amount })
      expect(status, `amount ${amount}`).toBe(400)
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(body.error).toMatch(/inte är 0 kr/)
      expect(findCall('salary_line_items', 'insert')).toBeUndefined()
    }
  })

  it('returns 400 for a wrong sign, and writes nothing', async () => {
    for (const [item_type, amount] of [
      ['gross_deduction_other', 1000],
      ['mileage_taxfree', -300],
      ['benefit_other', -100],
    ] as const) {
      const { enqueueMany, findCall } = authedWithCalls()
      enqueueMany([
        { data: { id: 'run-1', status: 'draft' } },
        { data: { id: SRE_UUID, employee_id: 'emp-1' } },
      ])
      const { status, body } = await post({ ...validBody, item_type, amount })
      expect(status, item_type).toBe(400)
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(findCall('salary_line_items', 'insert')).toBeUndefined()
    }
  })

  it('returns 404 for an unknown run', async () => {
    const { enqueueMany } = authedWithCalls()
    enqueueMany([{ data: null }])
    const { status, body } = await post(textBody)
    expect(status).toBe(404)
    expect(body.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 404 for an employee who is not on the run', async () => {
    const { enqueueMany } = authedWithCalls()
    enqueueMany([{ data: { id: 'run-1', status: 'draft' } }, { data: null }])
    const { status, body } = await post(textBody)
    expect(status).toBe(404)
    expect(body.code).toBe('SALARY_RUN_EMPLOYEE_NOT_FOUND')
  })
})

// Vacation days taken (item_type 'vacation', quantity = days): the docs say
// the days alone are enough, but an omitted amount was refused before the
// days were read (crm#1331).
describe('POST /api/salary/runs/[id]/lines: vacation rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  function authedWithCalls() {
    const mock = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mock.supabase as never,
      error: null,
    })
    return mock
  }

  const vacationBody = {
    salary_run_employee_id: SRE_UUID,
    item_type: 'vacation',
    description: 'Semester',
    quantity: 5,
  }

  async function post(body: unknown) {
    const response = await POST(
      createMockRequest('/api/salary/runs/run-1/lines', { method: 'POST', body }),
      createMockRouteParams({ id: 'run-1' }),
    )
    return parseJsonResponse<{ data?: { id: string }; error?: string; code?: string }>(response)
  }

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await post(vacationBody)
    expect(status).toBe(401)
  })

  it('creates a vacation row with days and no amount, stored at 0 kr (201)', async () => {
    const { enqueueMany, findCall } = authedWithCalls()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: SRE_UUID, employee_id: 'emp-1' } },
      { data: { id: 'li-vacation' } },
    ])
    const { status, body } = await post({ ...vacationBody, vacation_category: 'saved' })
    expect(status).toBe(201)
    expect(body.data?.id).toBe('li-vacation')
    expect(findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      item_type: 'vacation',
      quantity: 5,
      amount: 0,
      vacation_category: 'saved',
    })
  })

  it('keeps the explicit 0 kr workaround and a semestertillägg amount working (201)', async () => {
    for (const amount of [0, 860]) {
      const { enqueueMany, findCall } = authedWithCalls()
      enqueueMany([
        { data: { id: 'run-1', status: 'draft' } },
        { data: { id: SRE_UUID, employee_id: 'emp-1' } },
        { data: { id: 'li-vacation' } },
      ])
      const { status } = await post({ ...vacationBody, amount })
      expect(status, `amount ${amount}`).toBe(201)
      expect(findCall('salary_line_items', 'insert')?.[0]).toMatchObject({ quantity: 5, amount })
    }
  })

  it('returns 400 with the Swedish reason for a vacation row with neither days nor an amount', async () => {
    const { enqueueMany, findCall } = authedWithCalls()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { id: SRE_UUID, employee_id: 'emp-1' } },
    ])
    const { status, body } = await post({ ...vacationBody, quantity: undefined })
    expect(status).toBe(400)
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toMatch(/semesterrad behöver antal semesterdagar/)
    expect(findCall('salary_line_items', 'insert')).toBeUndefined()
  })

  it('returns 404 for an unknown run', async () => {
    const { enqueueMany } = authedWithCalls()
    enqueueMany([{ data: null }])
    const { status, body } = await post(vacationBody)
    expect(status).toBe(404)
    expect(body.code).toBe('SALARY_RUN_NOT_FOUND')
  })
})
