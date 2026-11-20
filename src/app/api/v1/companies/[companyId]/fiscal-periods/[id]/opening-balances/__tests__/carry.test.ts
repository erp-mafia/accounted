/**
 * POST /api/v1/companies/:companyId/fiscal-periods/:id/opening-balances
 *
 * Carries the closed year's UB into the next year's IB through
 * generateOpeningBalances. One IB per year (ÅRL 2:4): the refusal is the
 * service's own check (assertNoOpeningBalance: the pointer or a posted IB
 * verifikat), answered 409 CONFLICT with reason opening_balance_already_posted
 * before anything is posted. The route used to count IB rows itself, which
 * also counted a reversed IB and left every other door unguarded.
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})

const createJournalEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args) }
})
const trialBalanceMock = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalanceMock(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

/** Per-table answers (the last entry repeats) that record every (table, method, args). */
function makeClient(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const { supabase, calls } = createTableMockSupabase(byTable)
  return Object.assign(supabase, { calls })
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLOSED_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NEXT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const IB_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/fiscal-periods/${CLOSED_ID}/opening-balances`
const params = (id = CLOSED_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

const OWNED = { data: { id: CLOSED_ID }, error: null }
const NO_POINTER = { data: { opening_balances_set: false, opening_balance_entry_id: null, opening_balance_entry: null }, error: null }
const NEXT_YEAR = { data: { id: NEXT_ID, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null }

function request(body: unknown): Request {
  return new Request(URL_, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
  createJournalEntryMock.mockResolvedValue({ id: IB_ID, voucher_series: 'A', voucher_number: 1 })
  trialBalanceMock.mockResolvedValue({
    rows: [
      { account_number: '1930', account_name: 'Företagskonto', account_class: 1, closing_debit: 5000, closing_credit: 0 },
      { account_number: '2099', account_name: 'Årets resultat', account_class: 2, closing_debit: 0, closing_credit: 5000 },
    ],
    totalDebit: 5000,
    totalCredit: 5000,
    isBalanced: true,
  })
})

describe('POST .../fiscal-periods/{id}/opening-balances', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await POST(request({ next_period_id: NEXT_ID }), params())).status).toBe(401)
  })

  it('400 for a malformed period id or body', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await POST(request({ next_period_id: NEXT_ID }), params('not-a-uuid'))).status).toBe(400)
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await POST(request({ next_period_id: 'nope' }), params())).status).toBe(400)
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await POST(request('{'), params())).status).toBe(400)
  })

  it('404 when the next period is not the company\'s', async () => {
    const client = makeClient({ company_members: OWNER, fiscal_periods: [OWNED, { data: null, error: null }] })
    mockServiceClient.mockReturnValue(client)
    const res = await POST(request({ next_period_id: NEXT_ID }), params())
    expect(res.status).toBe(404)
    expect((await res.json()).error.details.field).toBe('next_period_id')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('409 CONFLICT opening_balance_already_posted for a posted IB the next year has no pointer to, posting nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      fiscal_periods: [OWNED, OWNED, NO_POINTER],
      journal_entries: { data: [{ id: IB_ID, voucher_series: 'A', voucher_number: 4 }], error: null },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await POST(request({ next_period_id: NEXT_ID }), params())

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.details).toMatchObject({
      reason: 'opening_balance_already_posted',
      next_period_id: NEXT_ID,
      existing_entry_id: IB_ID,
    })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(trialBalanceMock).not.toHaveBeenCalled()
    const books = new Set(['fiscal_periods', 'journal_entries', 'journal_entry_lines'])
    expect(client.calls.some((c) => books.has(c.table) && ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toBe(false)
  })

  it('200 carries the IB and links the next year; only posted IBs count, so a reversed one does not block', async () => {
    const client = makeClient({
      company_members: OWNER,
      fiscal_periods: [OWNED, OWNED, NO_POINTER, NEXT_YEAR, { data: null, error: null }],
      journal_entries: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await POST(request({ next_period_id: NEXT_ID }), params())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ opening_entry_id: IB_ID, voucher_series: 'A', voucher_number: 1, next_period_id: NEXT_ID })
    const ibRead = client.calls.filter((c) => c.table === 'journal_entries' && c.method === 'eq').map((c) => c.args)
    expect(ibRead).toContainEqual(['status', 'posted'])
    expect(ibRead).toContainEqual(['source_type', 'opening_balance'])
    expect(client.calls).toContainEqual({
      table: 'fiscal_periods',
      method: 'update',
      args: [{ opening_balance_entry_id: IB_ID, opening_balances_set: true }],
    })
  })
})
