/**
 * PATCH /api/salary/employees/[id] and a changed sysselsättningsgrad on a
 * sammalöneregeln employee (#31, semesterlagen 16 § andra stycket 3-4): the
 * dashboard door answers the command's own code with the Swedish sentence,
 * writes the switch to procentregeln, and attributes a kollektivavtal
 * confirmation (2 a §) to the signed-in user in audit_log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

// Route path ids are uuids: the route answers its 404 to anything else before it reads.
const EMP_1 = 'fcd49043-9489-5813-aacd-a04b3e121e68'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const auditInsert = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ insert: auditInsert }) }),
}))

import { PATCH } from '../route'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { SAMMALONEREGELN_DEGREE_CHANGED } from '@/lib/salary/employee-update-rules'

const params = { params: Promise.resolve({ id: EMP_1 }) } as never

const SAMMALONE_ROW = {
  id: EMP_1,
  company_id: 'company-1',
  first_name: 'Test',
  last_name: 'Testsson',
  // Synthetic fixture, only ever masked.
  personnummer: encryptPersonnummer('190203040000'),
  employment_type: 'employee',
  salary_type: 'monthly',
  monthly_salary: 30000,
  f_skatt_status: 'a_skatt',
  is_sidoinkomst: false,
  tax_table_number: 34,
  employment_degree: 100,
  hours_per_week: 40,
  workdays_per_week: 5,
  vacation_rule: 'sammaloneregeln',
  is_active: true,
}

/**
 * Reads answer `existing`; an update answers the merged row. `updates()` is
 * every payload handed to `.update()` (empty: nothing was written).
 */
function useRow(existing: Record<string, unknown> | null) {
  const mock = createTableMockSupabase({
    employees: (chainCalls) => {
      const update = chainCalls.find((c) => c.method === 'update')
      return { data: update ? { ...existing, ...(update.args[0] as Record<string, unknown>) } : existing }
    },
  })
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
  return { updates: () => mock.payloads('employees', 'update') }
}

const patchRequest = (body: Record<string, unknown>) =>
  createMockRequest(`/api/salary/employees/${EMP_1}`, { method: 'PATCH', body })

describe('PATCH /api/salary/employees/[id]: employment degree on sammalöneregeln (#31)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWriteMock.mockResolvedValue({ ok: true })
    auditInsert.mockResolvedValue({ error: null })
  })

  it('401 when unauthenticated, and nothing is written', async () => {
    const row = useRow({ ...SAMMALONE_ROW })
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await PATCH(patchRequest({ employment_degree: 80 }), params)

    expect(response.status).toBe(401)
    expect(row.updates()).toEqual([])
  })

  it('400 with the code and the Swedish sentence when the degree changes and the rule stays', async () => {
    const row = useRow({ ...SAMMALONE_ROW })

    const response = await PATCH(patchRequest({ employment_degree: 80, vacation_rule: 'sammaloneregeln' }), params)
    const { status, body } = await parseJsonResponse<{ error: string; code: string }>(response)

    expect(status).toBe(400)
    expect(body.code).toBe('EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED')
    expect(body.error).toBe(`${SAMMALONEREGELN_DEGREE_CHANGED}.`)
    expect(row.updates()).toEqual([])
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('200 and writes the degree with procentregeln in the same save', async () => {
    const row = useRow({ ...SAMMALONE_ROW })

    const response = await PATCH(patchRequest({ employment_degree: 80, vacation_rule: 'procentregeln' }), params)

    expect(response.status).toBe(200)
    expect(row.updates()).toEqual([{ employment_degree: 80, vacation_rule: 'procentregeln' }])
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('200 on a kollektivavtal confirmation: the key is not written, the record names the signed-in user', async () => {
    const row = useRow({ ...SAMMALONE_ROW })

    const response = await PATCH(
      patchRequest({ employment_degree: 80, vacation_rule: 'sammaloneregeln', sammaloneregeln_kollektivavtal_confirmed: true }),
      params,
    )

    expect(response.status).toBe(200)
    expect(row.updates()).toEqual([{ employment_degree: 80, vacation_rule: 'sammaloneregeln' }])
    expect(auditInsert).toHaveBeenCalledTimes(1)
    expect(auditInsert.mock.calls[0][0]).toMatchObject({
      user_id: 'user-1',
      company_id: 'company-1',
      action: 'GUARD_BYPASSED',
      table_name: 'employees',
      record_id: EMP_1,
      actor_type: 'user',
      new_state: { employment_degree_from: 100, employment_degree_to: 80 },
    })
  })

  it('200 for the unchanged degree the form always sends', async () => {
    const row = useRow({ ...SAMMALONE_ROW })

    const response = await PATCH(patchRequest({ employment_degree: 100, phone: '0700000000' }), params)

    expect(response.status).toBe(200)
    expect(row.updates()).toEqual([{ employment_degree: 100, phone: '0700000000' }])
  })

  it('400 for a confirmation that is not a boolean, and nothing is written', async () => {
    const row = useRow({ ...SAMMALONE_ROW })

    const response = await PATCH(
      patchRequest({ employment_degree: 80, sammaloneregeln_kollektivavtal_confirmed: 'yes' }),
      params,
    )

    expect(response.status).toBe(400)
    expect(row.updates()).toEqual([])
  })

  it('404 when no employee row matches, and nothing is written', async () => {
    const row = useRow(null)

    const response = await PATCH(patchRequest({ employment_degree: 80 }), params)

    expect(response.status).toBe(404)
    expect(row.updates()).toEqual([])
  })
})
