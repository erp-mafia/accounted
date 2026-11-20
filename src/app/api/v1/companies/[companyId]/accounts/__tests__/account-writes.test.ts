/**
 * Chart of accounts writes through the v1 door of the operation registry
 * (src/lib/operations/accounts.ts via lib/operations/v1.ts):
 *   POST   /api/v1/companies/:companyId/accounts
 *   PATCH  /api/v1/companies/:companyId/accounts/:number
 *   DELETE /api/v1/companies/:companyId/accounts/:number
 *   POST   /api/v1/companies/:companyId/accounts/activate
 *   POST   /api/v1/companies/:companyId/accounts/deactivate
 *
 * The rules themselves (lib/bookkeeping/chart-of-accounts-service.ts) are
 * shared with the dashboard routes and the MCP tools; here: auth, validation,
 * the path number reaching the input as a string, dry runs writing nothing,
 * and the registry codes for the refusals.
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as createAccount } from '../route'
import { PATCH as updateAccount, DELETE as deleteAccount } from '../[number]/route'
import { POST as activateAccounts } from '../activate/route'
import { POST as deactivateAccounts } from '../deactivate/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock (the last entry repeats) that records every (table, method, args). */
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
  return {
    calls,
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn(() => buildChain('rpc')),
  }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const chartWrites = (client: ReturnType<typeof makeClient>) =>
  client.calls.filter((c) => c.table === 'chart_of_accounts' && WRITES.has(c.method))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/accounts`

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
const numberParams = (number: string) => ({ params: Promise.resolve({ companyId: COMPANY_ID, number }) })

const ROW = {
  id: '8d0e0000-0000-4000-8000-000000000000',
  account_number: '5410',
  account_name: 'Förbrukningsinventarier',
  account_class: 5,
  account_group: '54',
  account_type: 'expense',
  normal_balance: 'debit',
  plan_type: 'full_bas',
  is_active: true,
  is_system_account: false,
  description: null,
  default_vat_code: null,
  default_vat_rate: null,
  default_vat_treatment: null,
  vat_box: null,
  sru_code: '7321',
  sort_order: 5410,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/accounts', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await createAccount(request(BASE, { method: 'POST', body: '{"account_number":"5410"}' }), companyParams)
    expect(res.status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await createAccount(request(BASE, { method: 'POST', body: '{"account_number":"5410"}' }), companyParams)
    expect(res.status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a numeric account_number and for a missing one', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    for (const body of ['{"account_number":5410}', '{}']) {
      const res = await createAccount(request(BASE, { method: 'POST', body }), companyParams)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('201 for a BAS number with nothing but the number: the catalogue fills the row', async () => {
    const client = makeClient({ company_members: MEMBER, chart_of_accounts: { data: ROW, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await createAccount(request(BASE, { method: 'POST', body: '{"account_number":"5410"}' }), companyParams)
    expect(res.status).toBe(201)
    expect((await res.json()).data.account_number).toBe('5410')
    const insert = client.calls.find((c) => c.table === 'chart_of_accounts' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({
      company_id: COMPANY_ID,
      user_id: 'user-1',
      account_number: '5410',
      account_class: 5,
      account_group: '54',
      account_type: 'expense',
      normal_balance: 'debit',
      plan_type: 'full_bas',
      sru_code: expect.any(String), // from the BAS 2026 catalogue
      is_active: true,
      is_system_account: false,
    })
  })

  it('400 ACCOUNT_TYPE_CLASS_CONFLICT for a type the class cannot hold, without writing', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    const res = await createAccount(
      request(BASE, {
        method: 'POST',
        body: JSON.stringify({ account_number: '2999', account_name: 'Fel', account_type: 'expense', normal_balance: 'debit' }),
      }),
      companyParams,
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ACCOUNT_TYPE_CLASS_CONFLICT')
    expect(chartWrites(client)).toEqual([])
  })

  it('400 ACCOUNT_DETAILS_REQUIRED for a number outside BAS 2026 without name/type/balance', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await createAccount(request(BASE, { method: 'POST', body: '{"account_number":"9999"}' }), companyParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ACCOUNT_DETAILS_REQUIRED')
  })

  it('409 ACCOUNT_EXISTS / ACCOUNT_EXISTS_INACTIVE on a duplicate number', async () => {
    for (const [isActive, code] of [
      [true, 'ACCOUNT_EXISTS'],
      [false, 'ACCOUNT_EXISTS_INACTIVE'],
    ] as const) {
      mockServiceClient.mockReturnValue(
        makeClient({
          company_members: MEMBER,
          chart_of_accounts: [
            { data: null, error: { code: '23505', message: 'duplicate key value' } },
            { data: { account_number: '5410', account_name: 'X', is_active: isActive }, error: null },
          ],
        }),
      )
      const res = await createAccount(request(BASE, { method: 'POST', body: '{"account_number":"5410"}' }), companyParams)
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe(code)
    }
  })

  it('a dry run previews the prefilled row and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, chart_of_accounts: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await createAccount(
      request(`${BASE}?dry_run=true`, { method: 'POST', body: '{"account_number":"5410","account_name":"Verktyg"}' }),
      companyParams,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({ account_number: '5410', account_name: 'Verktyg', source: 'bas_2026' })
    expect(chartWrites(client)).toEqual([])
  })

  it('a dry run of a duplicate answers the same 409 the real call would', async () => {
    const client = makeClient({
      company_members: MEMBER,
      chart_of_accounts: { data: { account_number: '5410', account_name: 'X', is_active: true }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await createAccount(
      request(`${BASE}?dry_run=true`, { method: 'POST', body: '{"account_number":"5410"}' }),
      companyParams,
    )
    expect(res.status).toBe(409)
    expect(chartWrites(client)).toEqual([])
  })
})

describe('PATCH /api/v1/companies/:companyId/accounts/:number', () => {
  it('takes the account number from the path as a string and applies a sparse update', async () => {
    const client = makeClient({ company_members: MEMBER, chart_of_accounts: { data: { ...ROW, is_active: false }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await updateAccount(
      request(`${BASE}/5410`, { method: 'PATCH', body: '{"is_active":false}' }),
      numberParams('5410'),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.is_active).toBe(false)
    const update = client.calls.find((c) => c.table === 'chart_of_accounts' && c.method === 'update')
    expect(update?.args[0]).toEqual({ is_active: false })
    expect(client.calls).toContainEqual({ table: 'chart_of_accounts', method: 'eq', args: ['account_number', '5410'] })
    expect(client.calls).toContainEqual({ table: 'chart_of_accounts', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it('400 ACCOUNT_NOTHING_TO_UPDATE for an empty body', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await updateAccount(request(`${BASE}/5410`, { method: 'PATCH', body: '{}' }), numberParams('5410'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ACCOUNT_NOTHING_TO_UPDATE')
  })

  it('400 ACCOUNT_VAT_BOX_NOT_VAT_ACCOUNT for a momsruta on a non-26xx account', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await updateAccount(
      request(`${BASE}/4545`, { method: 'PATCH', body: '{"vat_box":"60"}' }),
      numberParams('4545'),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ACCOUNT_VAT_BOX_NOT_VAT_ACCOUNT')
  })

  it('404 ACCOUNT_NOT_FOUND for a number outside the chart', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, chart_of_accounts: { data: null, error: { code: 'PGRST116', message: '0 rows' } } }),
    )
    const res = await updateAccount(
      request(`${BASE}/5410`, { method: 'PATCH', body: '{"account_name":"X"}' }),
      numberParams('5410'),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('ACCOUNT_NOT_FOUND')
  })

  it('a dry run returns current and changes, and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, chart_of_accounts: { data: ROW, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await updateAccount(
      request(`${BASE}/5410?dry_run=true`, { method: 'PATCH', body: '{"account_name":"Verktyg"}' }),
      numberParams('5410'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({ account_number: '5410', changes: { account_name: 'Verktyg' } })
    expect(chartWrites(client)).toEqual([])
  })
})

describe('DELETE /api/v1/companies/:companyId/accounts/:number', () => {
  const UNUSED = { id: ROW.id, account_number: '5410', account_name: 'X', is_system_account: false }

  it('deletes an unused account', async () => {
    const client = makeClient({
      company_members: MEMBER,
      chart_of_accounts: [{ data: UNUSED, error: null }, { data: null, error: null }],
      rpc: { data: [{ account_number: '1930', usage_count: 9 }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await deleteAccount(request(`${BASE}/5410`, { method: 'DELETE' }), numberParams('5410'))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ deleted: true, account_number: '5410' })
    expect(client.rpc).toHaveBeenCalledWith('get_account_usage_counts', { p_company_id: COMPANY_ID })
  })

  it('409 ACCOUNT_IN_USE for an account with journal lines, without deleting', async () => {
    const client = makeClient({
      company_members: MEMBER,
      chart_of_accounts: { data: UNUSED, error: null },
      rpc: { data: [{ account_number: '5410', usage_count: 3 }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await deleteAccount(request(`${BASE}/5410`, { method: 'DELETE' }), numberParams('5410'))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ACCOUNT_IN_USE')
    expect(chartWrites(client)).toEqual([])
  })

  it('400 ACCOUNT_SYSTEM_DELETE for a system account', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, chart_of_accounts: { data: { ...UNUSED, is_system_account: true }, error: null } }),
    )
    const res = await deleteAccount(request(`${BASE}/1930`, { method: 'DELETE' }), numberParams('1930'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ACCOUNT_SYSTEM_DELETE')
  })

  it('404 ACCOUNT_NOT_FOUND for a number outside the chart', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, chart_of_accounts: { data: null, error: null } }))
    const res = await deleteAccount(request(`${BASE}/5410`, { method: 'DELETE' }), numberParams('5410'))
    expect(res.status).toBe(404)
  })

  it('a dry run checks usage and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      chart_of_accounts: { data: UNUSED, error: null },
      rpc: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await deleteAccount(request(`${BASE}/5410?dry_run=true`, { method: 'DELETE' }), numberParams('5410'))
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ account_number: '5410', usage_count: 0 })
    expect(chartWrites(client)).toEqual([])
  })
})

describe('POST /api/v1/companies/:companyId/accounts/activate and /deactivate', () => {
  it('activate inserts BAS rows, reactivates inactive ones and reports unknown numbers', async () => {
    const client = makeClient({
      company_members: MEMBER,
      chart_of_accounts: [
        { data: [{ account_number: '6570', is_active: false }], error: null }, // lookup
        { data: [{ account_number: '6570' }], error: null }, // reactivate
        { data: [{ account_number: '5410' }], error: null }, // insert
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await activateAccounts(
      request(`${BASE}/activate`, { method: 'POST', body: '{"account_numbers":["5410","6570","9999"]}' }),
      companyParams,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ activated: 1, reactivated: 1, skipped: 0, unknown: ['9999'] })
  })

  it('400 when account_numbers is empty', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await activateAccounts(request(`${BASE}/activate`, { method: 'POST', body: '{"account_numbers":[]}' }), companyParams)
    expect(res.status).toBe(400)
  })

  it('a dry-run deactivation partitions the numbers and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      chart_of_accounts: {
        data: [
          { account_number: '1930', is_active: true, is_system_account: true },
          { account_number: '6991', is_active: true, is_system_account: false },
          { account_number: '7699', is_active: true, is_system_account: false },
        ],
        error: null,
      },
      rpc: { data: [{ account_number: '7699', usage_count: 4 }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await deactivateAccounts(
      request(`${BASE}/deactivate?dry_run=true`, { method: 'POST', body: '{"account_numbers":["1930","6991","7699"]}' }),
      companyParams,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({
      to_deactivate: ['6991'],
      skipped_system: ['1930'],
      skipped_used: ['7699'],
    })
    expect(chartWrites(client)).toEqual([])
  })
})
