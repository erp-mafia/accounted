/**
 * Expense claims (utlägg) through the v1 door of the operation registry
 * (src/lib/operations/expense-claims.ts via lib/operations/v1.ts):
 *   GET    /api/v1/companies/:companyId/expense-claims
 *   GET    /api/v1/companies/:companyId/expense-claims/:id
 *   POST   /api/v1/companies/:companyId/expense-claims
 *   DELETE /api/v1/companies/:companyId/expense-claims/:id
 *   POST   /api/v1/companies/:companyId/expense-claims/payouts
 *
 * The rules under test are the service's (lib/expenses/expense-claim-actions.ts
 * and expense-claims-service.ts): the liability account per claimant, a
 * verifikat that balances, the tenancy check on the receipt, the storno on
 * delete, the payout refusals, and dry runs that write nothing.
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
const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return {
    ...actual,
    createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
    reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
  }
})
const fetchExchangeRateMock = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => fetchExchangeRateMock(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listClaims, POST as createClaim } from '../route'
import { GET as getClaim, DELETE as deleteClaim } from '../[id]/route'
import { POST as recordPayout } from '../payouts/route'

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
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set([
  'expense_claims',
  'expense_payout_batches',
  'journal_entries',
  'journal_entry_lines',
  'document_attachments',
  'invoice_inbox_items',
  'salary_line_items',
  'transactions',
])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLAIM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CLAIM_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const EMPLOYEE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const DOC_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const JE_ID = '99999999-9999-4999-8999-999999999999'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/expense-claims`
const OPEN_YEAR = { data: { id: 'fp-2026', is_closed: false, locked_at: null }, error: null }
const OPEN_YEAR_LIST = { data: [{ id: 'fp-2026' }], error: null }

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const claimParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: CLAIM_ID }) }

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CLAIM_ID,
    company_id: COMPANY_ID,
    employee_id: null,
    claimant_name: 'Anna Svensson',
    description: 'USB-hubb',
    expense_date: '2026-09-01',
    amount_sek: '500.00',
    vat_sek: '100.00',
    currency: 'SEK',
    amount_in_currency: null,
    exchange_rate: null,
    expense_account: '5410',
    liability_account: '2893',
    document_id: null,
    status: 'registered',
    journal_entry_id: JE_ID,
    payout_batch_id: null,
    created_at: '2026-09-01T09:12:00.000Z',
    ...overrides,
  }
}

const validClaim = {
  description: 'USB-hubb',
  expense_date: '2026-09-01',
  amount: 500,
  vat_amount: 100,
  expense_account: '5410',
  claimant_name: 'Anna Svensson',
}

beforeEach(() => {
  vi.clearAllMocks()
  createJournalEntryMock.mockResolvedValue({ id: JE_ID })
  reverseEntryMock.mockResolvedValue({ id: 'storno-1' })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['suppliers:read', 'suppliers:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/expense-claims', () => {
  const list = (query = '') => listClaims(request(`${BASE}${query}`), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await list()).status).toBe(401)
  })

  it('403 without suppliers:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await list()).status).toBe(403)
  })

  it('400 on an unknown status or a limit out of range', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await list('?status=open')).status).toBe(400)
    expect((await list('?limit=0')).status).toBe(400)
  })

  it('lists the company\'s claims with qualified ids, filters, and a next_cursor when more rows exist', async () => {
    const older = claimRow({ id: CLAIM_B, created_at: '2026-08-01T09:00:00.000Z' })
    const client = makeClient({ company_members: MEMBER, expense_claims: { data: [claimRow(), older], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await list(`?status=registered&employee_id=${EMPLOYEE_ID}&limit=1`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.expense_claims).toHaveLength(1)
    expect(body.data.expense_claims[0]).toMatchObject({
      expense_claim_id: CLAIM_ID,
      amount_sek: 500,
      vat_sek: 100,
      liability_account: '2893',
      status: 'registered',
    })
    expect(body.data.expense_claims[0].id).toBeUndefined()
    expect(body.data.next_cursor).toEqual(expect.any(String))
    expect(client.calls).toContainEqual({ table: 'expense_claims', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(client.calls).toContainEqual({ table: 'expense_claims', method: 'eq', args: ['status', 'registered'] })
    expect(client.calls).toContainEqual({ table: 'expense_claims', method: 'eq', args: ['employee_id', EMPLOYEE_ID] })
    expect(client.calls).toContainEqual({ table: 'expense_claims', method: 'limit', args: [2] })
  })

  it('a cursor continues strictly after the last row of the previous page', async () => {
    const client = makeClient({ company_members: MEMBER, expense_claims: { data: [], error: null } })
    mockServiceClient.mockReturnValue(client)
    const cursor = Buffer.from(JSON.stringify({ ts: '2026-09-01T09:12:00.000Z', id: CLAIM_ID }), 'utf8').toString('base64url')
    const res = await list(`?cursor=${cursor}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data.next_cursor).toBeNull()
    expect(client.calls).toContainEqual({
      table: 'expense_claims',
      method: 'or',
      args: [`created_at.lt.2026-09-01T09:12:00.000Z,and(created_at.eq.2026-09-01T09:12:00.000Z,id.lt.${CLAIM_ID})`],
    })
  })
})

describe('GET /api/v1/companies/:companyId/expense-claims/:id', () => {
  it('404 EXPENSE_CLAIM_NOT_FOUND for an id outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, expense_claims: { data: null, error: null } }))
    const res = await getClaim(request(`${BASE}/${CLAIM_ID}`), claimParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('EXPENSE_CLAIM_NOT_FOUND')
  })

  it('400 for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await getClaim(request(`${BASE}/nope`), { params: Promise.resolve({ companyId: COMPANY_ID, id: 'nope' }) })
    expect(res.status).toBe(400)
  })

  it('answers the claim', async () => {
    const client = makeClient({ company_members: MEMBER, expense_claims: { data: claimRow({ status: 'paid', payout_batch_id: CLAIM_B }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await getClaim(request(`${BASE}/${CLAIM_ID}`), claimParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ expense_claim_id: CLAIM_ID, status: 'paid', payout_batch_id: CLAIM_B })
    expect(client.calls).toContainEqual({ table: 'expense_claims', method: 'eq', args: ['company_id', COMPANY_ID] })
  })
})

describe('POST /api/v1/companies/:companyId/expense-claims', () => {
  const post = (body: unknown, query = '') =>
    createClaim(request(`${BASE}${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post(validClaim)).status).toBe(401)
  })

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post(validClaim)).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for VAT at or above the amount, no claimant, or a balance-sheet cost account', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const vat = await post({ ...validClaim, vat_amount: 500 })
    expect(vat.status).toBe(400)
    expect((await vat.json()).error.code).toBe('VALIDATION_ERROR')
    const { claimant_name: _omit, ...noClaimant } = validClaim
    expect((await post(noClaimant)).status).toBe(400)
    expect((await post({ ...validClaim, expense_account: '1930' })).status).toBe(400)
  })

  it('registers an aktiebolag owner claim on 2893 and posts a balancing verifikat (201)', async () => {
    const client = makeClient({
      company_members: MEMBER,
      companies: { data: { entity_type: 'aktiebolag' }, error: null },
      fiscal_periods: [OPEN_YEAR, OPEN_YEAR_LIST],
      expense_claims: { data: claimRow({ journal_entry_id: null }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(validClaim)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({ expense_claim_id: CLAIM_ID, journal_entry_id: JE_ID, liability_account: '2893' })

    const insert = client.calls.find((c) => c.table === 'expense_claims' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({
      company_id: COMPANY_ID,
      liability_account: '2893',
      amount_sek: 500,
      vat_sek: 100,
      claimant_name: 'Anna Svensson',
      status: 'registered',
    })
    const entry = createJournalEntryMock.mock.calls[0][3]
    expect(entry).toMatchObject({ source_type: 'expense_claim', source_id: CLAIM_ID, fiscal_period_id: 'fp-2026' })
    expect(entry.lines).toEqual([
      expect.objectContaining({ account_number: '5410', debit_amount: 400, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2641', debit_amount: 100, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2893', debit_amount: 0, credit_amount: 500 }),
    ])
  })

  it('an employee claim books 2820 under the employee\'s own name', async () => {
    const client = makeClient({
      company_members: MEMBER,
      companies: { data: { entity_type: 'aktiebolag' }, error: null },
      employees: { data: { id: EMPLOYEE_ID, first_name: 'Erik', last_name: 'Berg' }, error: null },
      fiscal_periods: [OPEN_YEAR, OPEN_YEAR_LIST],
      expense_claims: { data: claimRow({ employee_id: EMPLOYEE_ID, liability_account: '2820' }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ ...validClaim, employee_id: EMPLOYEE_ID, claimant_name: 'Someone Else' })
    expect(res.status).toBe(201)
    const insert = client.calls.find((c) => c.table === 'expense_claims' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({ employee_id: EMPLOYEE_ID, claimant_name: 'Erik Berg', liability_account: '2820' })
  })

  it('404 EMPLOYEE_NOT_FOUND for an employee outside the company, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      companies: { data: { entity_type: 'aktiebolag' }, error: null },
      employees: { data: null, error: null },
      fiscal_periods: OPEN_YEAR,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ ...validClaim, employee_id: EMPLOYEE_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('EMPLOYEE_NOT_FOUND')
    expect(wrote(client)).toBe(false)
  })

  it('404 EXPENSE_CLAIM_DOCUMENT_NOT_FOUND for a receipt of another company, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: OPEN_YEAR,
      document_attachments: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ ...validClaim, document_id: DOC_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('EXPENSE_CLAIM_DOCUMENT_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'document_attachments', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(wrote(client)).toBe(false)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('400 PERIOD_LOCKED for a date behind the company lock date, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      company_settings: { data: { bookkeeping_locked_through: '2026-09-30' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(validClaim)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('PERIOD_LOCKED')
    expect(wrote(client)).toBe(false)
  })

  it('400 EXPENSE_CLAIM_INVALID_LINES when custom lines do not credit the liability with the amount', async () => {
    const client = makeClient({
      company_members: MEMBER,
      companies: { data: { entity_type: 'aktiebolag' }, error: null },
      fiscal_periods: OPEN_YEAR,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({
      ...validClaim,
      lines: [
        { account_number: '5410', debit_amount: 500, credit_amount: 0 },
        { account_number: '2890', debit_amount: 0, credit_amount: 500 },
      ],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('EXPENSE_CLAIM_INVALID_LINES')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the balancing verifikat and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      companies: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: [OPEN_YEAR, OPEN_YEAR_LIST],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(validClaim, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      liability_account: '2018',
      amount_sek: 500,
      vat_sek: 100,
      verifikat: { total_debit: 500, total_credit: 500 },
    })
    expect(body.data.preview.verifikat.lines).toContainEqual({ account_number: '2018', debit_amount: 0, credit_amount: 500 })
    expect(wrote(client)).toBe(false)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('a foreign dry run reads the rate without the cache client', async () => {
    fetchExchangeRateMock.mockResolvedValue({ currency: 'EUR', rate: 11.5, date: '2026-09-01' })
    const client = makeClient({
      company_members: MEMBER,
      companies: { data: { entity_type: 'aktiebolag' }, error: null },
      fiscal_periods: [OPEN_YEAR, OPEN_YEAR_LIST],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ ...validClaim, currency: 'EUR', amount: 10, vat_amount: 0 }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ amount_sek: 115, exchange_rate: 11.5 })
    expect(fetchExchangeRateMock).toHaveBeenCalledWith('EUR', expect.any(Date), undefined)
  })
})

describe('DELETE /api/v1/companies/:companyId/expense-claims/:id', () => {
  const del = (query = '') => deleteClaim(request(`${BASE}/${CLAIM_ID}${query}`, { method: 'DELETE' }), claimParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await del()).status).toBe(401)
  })

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await del()).status).toBe(403)
  })

  it('404 EXPENSE_CLAIM_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, expense_claims: { data: null, error: null } }))
    const res = await del()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('EXPENSE_CLAIM_NOT_FOUND')
  })

  it('409 EXPENSE_CLAIM_ALREADY_PAID for a paid claim, posting nothing', async () => {
    const client = makeClient({ company_members: MEMBER, expense_claims: { data: claimRow({ status: 'paid' }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('EXPENSE_CLAIM_ALREADY_PAID')
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('409 EXPENSE_CLAIM_ON_PAYSLIP for a claim on a payslip past draft', async () => {
    const client = makeClient({
      company_members: MEMBER,
      expense_claims: { data: claimRow(), error: null },
      salary_line_items: {
        data: { id: 'line-1', salary_run_employee: { salary_run_id: 'run-1', salary_run: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9 } } },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('EXPENSE_CLAIM_ON_PAYSLIP')
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('reverses the verifikat by storno and removes the register row; the verifikat is never deleted', async () => {
    const client = makeClient({
      company_members: MEMBER,
      expense_claims: { data: claimRow(), error: null },
      journal_entries: { data: { status: 'posted', reversed_by_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ deleted: true, expense_claim_id: CLAIM_ID, reversal_entry_id: 'storno-1' })
    expect(reverseEntryMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', JE_ID)
    expect(client.calls.some((c) => c.table === 'expense_claims' && c.method === 'delete')).toBe(true)
    expect(client.calls.some((c) => c.table === 'journal_entries' && WRITES.has(c.method))).toBe(false)
  })

  it('a dry run names the storno it would post and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      expense_claims: { data: claimRow(), error: null },
      journal_entries: { data: { status: 'posted', reversed_by_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await del('?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({
      expense_claim_id: CLAIM_ID,
      journal_entry_id: JE_ID,
      action: 'storno',
      amount_sek: 500,
    })
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })
})

describe('POST /api/v1/companies/:companyId/expense-claims/payouts', () => {
  const payout = { claim_ids: [CLAIM_ID], payout_date: '2026-09-05', cash_account: '1930' }
  const post = (body: unknown, query = '') =>
    recordPayout(request(`${BASE}/payouts${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post(payout)).status).toBe(401)
  })

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post(payout)).status).toBe(403)
  })

  it('400 for a cash account outside 19xx or no claims', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post({ ...payout, cash_account: '2893' })).status).toBe(400)
    expect((await post({ ...payout, claim_ids: [] })).status).toBe(400)
  })

  it('books the payout through the RPC with the acting user (201)', async () => {
    const client = makeClient({
      company_members: MEMBER,
      rpc: {
        data: { ok: true, batch_id: CLAIM_B, journal_entry_id: JE_ID, voucher_number: 118, total_sek: '500.00', claim_count: 1 },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(payout)
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({
      batch_id: CLAIM_B,
      journal_entry_id: JE_ID,
      voucher_number: 118,
      total_sek: 500,
      claim_count: 1,
    })
    expect(client.rpc).toHaveBeenCalledWith('create_expense_payout_batch', {
      p_company_id: COMPANY_ID,
      p_claim_ids: [CLAIM_ID],
      p_payout_date: '2026-09-05',
      p_cash_account: '1930',
      p_notes: null,
      p_user_id: 'user-1',
      p_transaction_id: null,
    })
  })

  it('maps an RPC refusal onto its code: a claim on a payslip is 409 EXPENSE_PAYOUT_ON_PAYSLIP', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, rpc: { data: { ok: false, code: 'ON_PAYSLIP' }, error: null } }),
    )
    const res = await post(payout)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('EXPENSE_PAYOUT_ON_PAYSLIP')
  })

  it('a dry run previews liability against cash and writes nothing, not even the RPC', async () => {
    const client = makeClient({
      company_members: MEMBER,
      expense_claims: { data: [claimRow()], error: null },
      salary_line_items: { data: [], error: null },
      fiscal_periods: OPEN_YEAR,
      chart_of_accounts: { data: { account_number: '1930', is_active: true }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(payout, '?dry_run=true')
    expect(res.status).toBe(200)
    const preview = (await res.json()).data.preview
    expect(preview).toMatchObject({ claim_count: 1, total_sek: 500, claimant_name: 'Anna Svensson' })
    expect(preview.verifikat.lines).toEqual([
      { account_number: '2893', debit_amount: 500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 500 },
    ])
    expect(client.rpc).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a dry run debits 2013 for an enskild firma owner\'s 2018 claim (eget uttag)', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        expense_claims: { data: [claimRow({ liability_account: '2018' })], error: null },
        salary_line_items: { data: [], error: null },
        fiscal_periods: OPEN_YEAR,
        chart_of_accounts: { data: { is_active: true }, error: null },
      }),
    )
    const res = await post(payout, '?dry_run=true')
    expect((await res.json()).data.preview.verifikat.lines[0]).toEqual({ account_number: '2013', debit_amount: 500, credit_amount: 0 })
  })

  it.each([
    ['a paid claim', [claimRow({ status: 'paid' })], [], 'EXPENSE_PAYOUT_ALREADY_PAID', 409],
    ['two people', [claimRow(), claimRow({ id: CLAIM_B, claimant_name: 'Erik Berg' })], [], 'EXPENSE_PAYOUT_MIXED_CLAIMANTS', 400],
    ['a claim on a payslip', [claimRow()], [{ source_expense_claim_id: CLAIM_ID }], 'EXPENSE_PAYOUT_ON_PAYSLIP', 409],
    ['a missing claim', [], [], 'EXPENSE_PAYOUT_CLAIMS_NOT_FOUND', 404],
  ])('a dry run refuses %s up front (%s)', async (_label, claims, lines, code, status) => {
    const client = makeClient({
      company_members: MEMBER,
      expense_claims: { data: claims, error: null },
      salary_line_items: { data: lines, error: null },
      fiscal_periods: OPEN_YEAR,
      chart_of_accounts: { data: { is_active: true }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ ...payout, claim_ids: [CLAIM_ID, CLAIM_B].slice(0, Math.max(1, claims.length)) }, '?dry_run=true')
    expect(res.status).toBe(status)
    expect((await res.json()).error.code).toBe(code)
    expect(wrote(client)).toBe(false)
  })

  it('a dry run refuses a cash account missing from the chart', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        expense_claims: { data: [claimRow()], error: null },
        salary_line_items: { data: [], error: null },
        fiscal_periods: OPEN_YEAR,
        chart_of_accounts: { data: null, error: null },
      }),
    )
    const res = await post(payout, '?dry_run=true')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('EXPENSE_PAYOUT_ACCOUNT_NOT_IN_CHART')
    expect(body.error.details).toMatchObject({ account: '1930' })
  })
})
