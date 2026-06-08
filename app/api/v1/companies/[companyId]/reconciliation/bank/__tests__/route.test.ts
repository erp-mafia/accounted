/**
 * Integration tests for POST .../reconciliation/bank/run and
 * GET .../reconciliation/bank/status.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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

const { runRecMock, statusMock } = vi.hoisted(() => ({
  runRecMock: vi.fn().mockResolvedValue({
    matches: [
      {
        transaction: {
          id: '11111111-1111-4111-8111-111111111111',
          date: '2026-05-12',
          description: 'Test',
          amount: -100,
        },
        glLine: {
          journal_entry_id: '22222222-2222-4222-8222-222222222222',
          voucher_number: 42,
          voucher_series: 'A',
          entry_date: '2026-05-12',
          entry_description: 'Voucher 42',
        },
        method: 'amount_date',
        confidence: 0.95,
      },
    ],
    applied: 1,
    errors: [],
  }),
  statusMock: vi.fn().mockResolvedValue({
    matched_transactions: 100,
    unmatched_transactions: 5,
    unmatched_gl_lines: 2,
    total_unmatched_amount: 1500,
    bank_balance: 50000,
    gl_balance: 48500,
    difference: 1500,
  }),
}))

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  runReconciliation: runRecMock,
  getReconciliationStatus: statusMock,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as runPOST } from '../run/route'
import { GET as statusGET } from '../status/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
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

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}
function getRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /reconciliation/bank/run', () => {
  beforeEach(() => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ['transactions:write'],
      mode: 'live',
    })
  })

  it('runs the matcher and applies results', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        cash_accounts: { data: { id: 'ca-1930', currency: 'SEK' }, error: null },
      }),
    )
    const res = await runPOST(
      postRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/reconciliation/bank/run`, {
        date_from: '2026-05-01',
        date_to: '2026-05-31',
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.matches).toHaveLength(1)
    expect(body.data.applied).toBe(1)
    expect(runRecMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ dryRun: false, accountNumber: '1930', cashAccountId: 'ca-1930' }),
    )
  })

  it('rejects an unknown settlement account', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // No matching cash_accounts row for the requested account_number.
        cash_accounts: { data: null, error: null },
      }),
    )
    const res = await runPOST(
      postRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/reconciliation/bank/run`, {
        account_number: '9999',
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
    expect(runRecMock).not.toHaveBeenCalled()
  })

  it('runs the default 1930 account even without a cash_accounts row (currency fallback)', async () => {
    // Mirrors the status endpoint's leniency: the primary SEK account always
    // reconciles via the currency fallback, so a company without a 1930
    // cash_accounts row is not blocked from running reconciliation.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        cash_accounts: { data: null, error: null },
      }),
    )
    const res = await runPOST(
      postRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/reconciliation/bank/run`, {
        account_number: '1930',
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    expect(runRecMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ accountNumber: '1930', cashAccountId: undefined }),
    )
  })

  it('dry-run passes dryRun: true into the matcher', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        cash_accounts: { data: { id: 'ca-1930', currency: 'SEK' }, error: null },
      }),
    )
    const res = await runPOST(
      postRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reconciliation/bank/run?dry_run=true`,
        {},
      ),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(runRecMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ dryRun: true }),
    )
  })

  it('rejects keys without transactions:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['transactions:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await runPOST(
      postRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reconciliation/bank/run`,
        {},
      ),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /reconciliation/bank/status', () => {
  beforeEach(() => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ['transactions:read'],
      mode: 'live',
    })
  })

  it('returns the status snapshot', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        cash_accounts: { data: { id: 'ca-1930', currency: 'SEK' }, error: null },
      }),
    )
    const res = await statusGET(
      getRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/reconciliation/bank/status`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.matched_transactions).toBe(100)
    expect(body.data.unmatched_transactions).toBe(5)
  })

  it('rejects invalid date filter', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        cash_accounts: { data: { id: 'ca-1930', currency: 'SEK' }, error: null },
      }),
    )
    const res = await statusGET(
      getRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reconciliation/bank/status?date_from=invalid`,
      ),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })
})
