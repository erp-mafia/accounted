import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getActiveCompanyId: vi.fn(),
  checkRateLimit: vi.fn(),
  ensureSandboxAgentProfile: vi.fn(),
  markEntriesNoDocRequired: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: mocks.requireAuth }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: mocks.getActiveCompanyId }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: mocks.checkRateLimit }))
vi.mock('@/lib/sandbox/ensure-agent', () => ({
  ensureSandboxAgentProfile: mocks.ensureSandboxAgentProfile,
}))
vi.mock('@/lib/bookkeeping/no-doc-required', () => ({
  markEntriesNoDocRequired: mocks.markEntriesNoDocRequired,
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: (accountNumber: string) => ({
    account_name: `Account ${accountNumber}`,
    account_class: Number(accountNumber[0]),
    account_group: accountNumber.slice(0, 2),
    account_type: 'asset',
    normal_balance: 'debit',
    sru_code: null,
    k2_excluded: false,
  }),
}))
vi.mock('@/lib/salary/personnummer', () => ({
  encryptPersonnummer: (value: string) => `encrypted:${value}`,
}))
vi.mock('../customers', () => ({
  buildSandboxCustomers: () => [
    { name: 'Björk & Partner AB' },
    { name: 'Schmidt GmbH' },
    { name: 'Anna Lindström' },
  ],
}))
vi.mock('../pending-operations', () => ({ buildSandboxPendingOperations: () => [] }))
vi.mock('../articles', () => ({ buildSandboxArticles: () => [] }))
vi.mock('../ledger-history', () => ({
  SANDBOX_LEDGER_ACCOUNT_NUMBERS: [],
  buildSandboxLedgerHistory: () => ({ entries: [], linesByEntryIndex: [] }),
}))
vi.mock('../salary-vouchers', () => ({
  SANDBOX_SALARY_ACCOUNT_NUMBERS: [],
  buildSandboxSalaryVouchers: () => [],
}))
vi.mock('../salary', () => ({
  SANDBOX_RUN_TOTALS: {
    total_gross: 0,
    total_tax: 0,
    total_net: 0,
    total_avgifter: 0,
    total_vacation_accrual: 0,
  },
  SANDBOX_TOTAL_VACATION_ACCRUAL_AVGIFTER: 0,
  buildSandboxEmployees: () => [
    { last_name: 'Andersson' },
    { last_name: 'Berg' },
  ],
  mapSandboxEmployeeIds: (rows: Array<{ id: string }>) => ({
    annaEmployeeId: rows[0].id,
    erikEmployeeId: rows[1].id,
  }),
  buildSandboxSalaryRuns: () => [
    { status: 'booked' },
    { status: 'draft' },
  ],
  buildSandboxSalaryRunEmployees: ({ annaEmployeeId, erikEmployeeId }: {
    annaEmployeeId: string
    erikEmployeeId: string
  }) => [
    { employee_id: annaEmployeeId },
    { employee_id: erikEmployeeId },
  ],
  buildSandboxSalaryLineItems: () => [],
  resolveSandboxSalaryPeriods: () => ({
    booked: { paymentDate: '2026-04-25', year: 2026, month: 4 },
  }),
}))

import { POST } from '../route'

interface MockSupabaseResult {
  supabase: Record<string, unknown>
  deadlineInserts: unknown[][]
}

function createMockSupabase(): MockSupabaseResult {
  let rowId = 0
  let voucherNumber = 0
  const deadlineInserts: unknown[][] = []

  const from = vi.fn((table: string) => {
    let insertPayload: unknown = undefined
    const chain: Record<string, unknown> = {}

    const insertedRows = () => {
      if (insertPayload === undefined) return []
      const rows = Array.isArray(insertPayload) ? insertPayload : [insertPayload]
      return rows.map(row => ({
        ...(row as Record<string, unknown>),
        id: `${table}-${++rowId}`,
      }))
    }

    chain.insert = (payload: unknown) => {
      insertPayload = payload
      if (table === 'deadlines') deadlineInserts.push(payload as unknown[])
      return chain
    }
    chain.update = () => chain
    chain.select = () => chain
    for (const method of ['eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'not', 'or']) {
      chain[method] = () => chain
    }
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.single = async () => ({ data: insertedRows()[0] ?? { id: `${table}-${++rowId}` }, error: null })
    chain.then = (resolve: (value: unknown) => void) => resolve({
      data: insertedRows(),
      error: null,
    })

    return chain
  })

  const supabase = {
    from,
    rpc: vi.fn(async (fn: string) => ({
      data: fn === 'next_voucher_number' ? ++voucherNumber : null,
      error: null,
    })),
  }

  return { supabase, deadlineInserts }
}

function request(): Request {
  return new Request('http://localhost:3000/api/sandbox/seed', {
    method: 'POST',
    headers: { 'x-forwarded-for': '192.0.2.15' },
  })
}

describe('POST /api/sandbox/seed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0))
    mocks.checkRateLimit.mockResolvedValue({ ok: true })
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.ensureSandboxAgentProfile.mockResolvedValue(undefined)
    mocks.markEntriesNoDocRequired.mockResolvedValue(undefined)
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('returns 401 when authentication fails', async () => {
    mocks.requireAuth.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(request())

    expect(response.status).toBe(401)
  })

  it('inserts the canonical quarterly VAT deadline during a successful seed', async () => {
    const { supabase, deadlineInserts } = createMockSupabase()
    mocks.requireAuth.mockResolvedValue({
      error: null,
      user: { id: 'user-1', is_anonymous: true },
      supabase,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ seeded: true })
    expect(deadlineInserts).toHaveLength(1)
    expect(deadlineInserts[0][0]).toMatchObject({
      title: 'Momsdeklaration Q2 2026',
      due_date: '2026-08-17',
      tax_deadline_type: 'moms_quarterly',
      tax_period: '2026-Q2',
    })
  })
})
