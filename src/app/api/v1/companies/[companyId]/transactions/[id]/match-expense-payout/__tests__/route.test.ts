/**
 * POST /api/v1/companies/:companyId/transactions/:id/match-expense-payout
 * (operation transactions.match-expense-payout, lib/operations/expense-claims.ts):
 * an unbooked SEK outflow booked as the repayment of one person's utlägg,
 * through the same RPC as the dashboard, linked in the same transaction. The
 * rules are lib/expenses/expense-claim-actions.ts: outflow only, SEK only, not
 * already booked, the claims summing to the transfer, and a dry run that
 * writes nothing.
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as matchPayout } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that also records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: 'rpc', method: 'rpc', args })
    return buildChain('rpc')
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['expense_claims', 'expense_payout_batches', 'journal_entries', 'journal_entry_lines', 'transactions'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CLAIM_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CLAIM_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = '99999999-9999-4999-8999-999999999999'
const BATCH_ID = '88888888-8888-4888-8888-888888888888'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-expense-payout`
const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) }

function request(query = '', body: unknown = { claim_ids: [CLAIM_A, CLAIM_B] }): Request {
  return new Request(`${URL_BASE}${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    date: '2026-09-10',
    amount: -1596,
    currency: 'SEK',
    journal_entry_id: null,
    cash_account_id: null,
    transaction_voucher_links: [],
    ...overrides,
  }
}

function claim(id: string, amount: number) {
  return {
    id,
    status: 'registered',
    employee_id: null,
    claimant_name: 'Anna Svensson',
    liability_account: '2893',
    amount_sek: amount,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-expense-payout', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await matchPayout(request(), params)).status).toBe(401)
  })

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:write'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await matchPayout(request(), params)).status).toBe(403)
  })

  it('400 VALIDATION_ERROR on an empty claim list', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await matchPayout(request('', { claim_ids: [] }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 TX_CATEGORIZE_TX_NOT_FOUND for a transaction outside the company', async () => {
    const client = makeClient({ company_members: MEMBER, transactions: { data: null, error: { message: 'no rows' } } })
    mockServiceClient.mockReturnValue(client)
    const res = await matchPayout(request(), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'transactions', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it.each([
    ['an incoming row', txRow({ amount: 1596 }), 'EXPENSE_PAYOUT_MATCH_NOT_EXPENSE'],
    ['a EUR row', txRow({ currency: 'EUR' }), 'EXPENSE_PAYOUT_MATCH_CURRENCY'],
    ['a row in a samlingsverifikat', txRow({ transaction_voucher_links: [{ journal_entry_id: JE_ID, role: 'bank_line' }] }), 'EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED'],
  ])('400 for %s, writing nothing', async (_label, row, code) => {
    const client = makeClient({ company_members: MEMBER, transactions: { data: row, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await matchPayout(request(), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(code)
    expect(wrote(client)).toBe(false)
  })

  it('books the payout from the bank row: its date, its cash account, linked in the RPC', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: txRow(), error: null },
      cash_accounts: { data: [{ ledger_account: '1920' }], error: null },
      rpc: {
        data: { ok: true, batch_id: BATCH_ID, journal_entry_id: JE_ID, voucher_number: 12, total_sek: 1596, claim_count: 2 },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await matchPayout(request(), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      transaction_id: TX_ID,
      batch_id: BATCH_ID,
      journal_entry_id: JE_ID,
      voucher_number: 12,
      total_sek: 1596,
      claim_count: 2,
    })
    expect(client.rpc).toHaveBeenCalledWith('create_expense_payout_batch', {
      p_company_id: COMPANY_ID,
      p_claim_ids: [CLAIM_A, CLAIM_B],
      p_payout_date: '2026-09-10',
      p_cash_account: '1920',
      p_notes: null,
      p_user_id: 'user-1',
      p_transaction_id: TX_ID,
    })
  })

  it('maps the RPC\'s amount refusal onto EXPENSE_PAYOUT_MATCH_AMOUNT', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        transactions: { data: txRow(), error: null },
        cash_accounts: { data: [{ ledger_account: '1930' }], error: null },
        rpc: { data: { ok: false, code: 'TX_AMOUNT_MISMATCH' }, error: null },
      }),
    )
    const res = await matchPayout(request(), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('EXPENSE_PAYOUT_MATCH_AMOUNT')
  })

  it('a dry run previews the booking on the row\'s account and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: txRow(), error: null },
      cash_accounts: { data: [{ ledger_account: '1920' }], error: null },
      expense_claims: { data: [claim(CLAIM_A, 1000), claim(CLAIM_B, 596)], error: null },
      salary_line_items: { data: [], error: null },
      fiscal_periods: { data: { id: 'fp-2026', is_closed: false, locked_at: null }, error: null },
      chart_of_accounts: { data: { is_active: true }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await matchPayout(request('?dry_run=true'), params)
    expect(res.status).toBe(200)
    const preview = (await res.json()).data.preview
    expect(preview).toMatchObject({ transaction_id: TX_ID, total_sek: 1596, claim_count: 2, payout_date: '2026-09-10' })
    expect(preview.verifikat.lines).toEqual([
      { account_number: '2893', debit_amount: 1596, credit_amount: 0 },
      { account_number: '1920', debit_amount: 0, credit_amount: 1596 },
    ])
    expect(client.rpc).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a dry run refuses claims that do not sum to the transfer', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: txRow(), error: null },
      cash_accounts: { data: [{ ledger_account: '1930' }], error: null },
      expense_claims: { data: [claim(CLAIM_A, 1000), claim(CLAIM_B, 500)], error: null },
      salary_line_items: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await matchPayout(request('?dry_run=true'), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('EXPENSE_PAYOUT_MATCH_AMOUNT')
    expect(body.error.details).toMatchObject({ transaction_amount: -1596, claims_total: 1500 })
    expect(wrote(client)).toBe(false)
  })
})
