/**
 * Cash account writes through the v1 door of the operation registry
 * (src/lib/operations/cash-accounts.ts via lib/operations/v1.ts):
 *   POST /api/v1/companies/:companyId/cash-accounts
 *   PATCH /api/v1/companies/:companyId/cash-accounts/:id
 *   POST /api/v1/companies/:companyId/cash-accounts/:id/set-primary
 *   PUT  /api/v1/companies/:companyId/cash-accounts/payee-defaults
 *
 * The rules under test are the service's (lib/cash-accounts/manage.ts): the
 * owner/admin gate that the service role would otherwise skip, the
 * duplicate-IBAN refusal, and a dry run that writes nothing.
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
vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: vi.fn().mockResolvedValue({ error: null }),
}))
const findFreeLedgerAccountMock = vi.fn()
vi.mock('@/lib/cash-accounts/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cash-accounts/service')>('@/lib/cash-accounts/service')
  return { ...actual, findFreeLedgerAccount: (...args: unknown[]) => findFreeLedgerAccountMock(...args) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { POST as createCashAccount } from '../route'
import { PATCH as updateCashAccount } from '../[id]/route'
import { POST as setPrimary } from '../[id]/set-primary/route'
import { PUT as setPayeeDefault } from '../payee-defaults/route'

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
const BOOKS = new Set(['cash_accounts', 'invoice_payee_defaults', 'chart_of_accounts'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CA_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/cash-accounts`
const IBAN = 'SE4550000000058398257466'

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
const accountParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: CA_ID }) }

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CA_ID,
    company_id: COMPANY_ID,
    bank_connection_id: null,
    ledger_account: '1931',
    name: 'Sparkonto',
    currency: 'SEK',
    iban: null,
    payee_iban: null,
    source: 'manual',
    enabled: true,
    is_primary: false,
    voucher_series: null,
    invoice_payee: true,
    balance: 1234.5,
    available_balance: null,
    balance_updated_at: null,
    bank_name: null,
    clearing_number: null,
    account_number: null,
    bankgiro: '5050-1234',
    plusgiro: null,
    swish: null,
    bic: null,
    bank_code: null,
    foreign_account_number: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  findFreeLedgerAccountMock.mockResolvedValue('1931')
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:read', 'companies:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/cash-accounts', () => {
  const post = (body: unknown, query = '') =>
    createCashAccount(request(`${BASE}${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ name: 'Sparkonto', currency: 'SEK' })).status).toBe(401)
  })

  it('403 without companies:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ name: 'Sparkonto', currency: 'SEK' })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR on a missing name or a ledger account outside 1920-1999', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const missing = await post({ currency: 'SEK' })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await post({ name: 'Kassa', currency: 'SEK', ledger_account: '1910' })).status).toBe(400)
  })

  it('403 FORBIDDEN for a member key: the service role would otherwise skip the owner/admin rule', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ name: 'Sparkonto', currency: 'SEK' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('FORBIDDEN')
    expect(wrote(client)).toBe(false)
  })

  it('201 on the next free 19xx slot, with the curated shape (no balance)', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: [
        { data: [{ id: OTHER_ID, ledger_account: '1930', iban: null, payee_iban: null }], error: null },
        { data: row({ iban: IBAN, payee_iban: IBAN }), error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ name: 'Sparkonto', currency: 'SEK', payee: { bankgiro: '5050-1234', iban: 'se45 5000 0000 0583 9825 7466' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({ cash_account_id: CA_ID, ledger_account: '1931', source: 'manual', payee: { iban: IBAN } })
    expect(body.data.balance).toBeUndefined()
    expect(findFreeLedgerAccountMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'SEK', new Set(['1930']))
    const insert = client.calls.find((c) => c.table === 'cash_accounts' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({
      company_id: COMPANY_ID,
      ledger_account: '1931',
      source: 'manual',
      is_primary: false,
      iban: IBAN,
      payee_iban: IBAN,
      bankgiro: '5050-1234',
    })
  })

  it('409 CASH_ACCOUNT_IBAN_DUPLICATE when another row already carries the IBAN (Grönsinka), writing nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: { data: [{ id: OTHER_ID, ledger_account: '1930', iban: IBAN, payee_iban: null }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ name: 'Företagskonto', currency: 'SEK', payee: { iban: 'SE45 5000 0000 0583 9825 7466' } })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('CASH_ACCOUNT_IBAN_DUPLICATE')
    expect(wrote(client)).toBe(false)
    expect(syncMappedAccounts).not.toHaveBeenCalled()
  })

  it('409 CASH_ACCOUNT_LEDGER_TAKEN for a ledger account another row holds', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: { data: [{ id: OTHER_ID, ledger_account: '1940', iban: null, payee_iban: null }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ name: 'Sparkonto', currency: 'SEK', ledger_account: '1940' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CASH_ACCOUNT_LEDGER_TAKEN')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the ledger slot and writes nothing, not even the chart row', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: { data: [{ id: OTHER_ID, ledger_account: '1930', iban: null, payee_iban: null }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ name: 'Sparkonto', currency: 'SEK' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({ ledger_account: '1931', ledger_auto_picked: true, source: 'manual' })
    expect(wrote(client)).toBe(false)
    expect(syncMappedAccounts).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/v1/companies/:companyId/cash-accounts/:id', () => {
  const patch = (body: unknown, query = '') =>
    updateCashAccount(request(`${BASE}/${CA_ID}${query}`, { method: 'PATCH', body: JSON.stringify(body) }), accountParams)

  it('400 when the body changes nothing or carries an unknown key', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await patch({})).status).toBe(400)
    expect((await patch({ ledger_account: '1940' })).status).toBe(400)
  })

  it('400 for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await updateCashAccount(
      request(`${BASE}/nope`, { method: 'PATCH', body: '{"voucher_series":"M"}' }),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: 'nope' }) },
    )
    expect(res.status).toBe(400)
  })

  it('404 CASH_ACCOUNT_NOT_FOUND for an id outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, cash_accounts: { data: null, error: null } }))
    const res = await patch({ voucher_series: 'M' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
  })

  it('sets the voucher series, which any writer may do (a member key too)', async () => {
    const client = makeClient({ company_members: MEMBER, cash_accounts: { data: row({ voucher_series: 'M' }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ voucher_series: 'M' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.voucher_series).toBe('M')
    const update = client.calls.find((c) => c.table === 'cash_accounts' && c.method === 'update')
    expect(update?.args[0]).toEqual({ voucher_series: 'M' })
    expect(client.calls).toContainEqual({ table: 'cash_accounts', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it('403 FORBIDDEN for a member changing payee details, without reading or writing the account', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ bankgiro: '5050-1055' })
    expect(res.status).toBe(403)
    expect(client.calls.some((c) => c.table === 'cash_accounts')).toBe(false)
  })

  it('400 INVOICE_PAYEE_ACCOUNT_INVALID for payee details on a PSP clearing account', async () => {
    const client = makeClient({ company_members: OWNER, cash_accounts: { data: { id: CA_ID, ledger_account: '1686' }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ bankgiro: '5050-1055' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVOICE_PAYEE_ACCOUNT_INVALID')
    expect(wrote(client)).toBe(false)
  })

  it('409 CASH_ACCOUNT_IBAN_DUPLICATE when the new IBAN is another account', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: [
        { data: { id: CA_ID, ledger_account: '1931', iban: null, payee_iban: null }, error: null },
        { data: [{ id: OTHER_ID, iban: IBAN, payee_iban: null }], error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ iban: IBAN })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CASH_ACCOUNT_IBAN_DUPLICATE')
    expect(wrote(client)).toBe(false)
  })

  it('400 CASH_ACCOUNT_DISABLE_PRIMARY: the primary cannot be turned off', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: { data: { id: CA_ID, is_primary: true, bank_connection_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ enabled: false })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('CASH_ACCOUNT_DISABLE_PRIMARY')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run of a payee change previews it and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: { data: { id: CA_ID, ledger_account: '1931', iban: null, payee_iban: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ bankgiro: '5050-1055', plusgiro: '' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toEqual({ cash_account_id: CA_ID, changes: { bankgiro: '5050-1055', plusgiro: null } })
    expect(wrote(client)).toBe(false)
  })
})

describe('POST /api/v1/companies/:companyId/cash-accounts/:id/set-primary', () => {
  const post = (query = '') =>
    setPrimary(request(`${BASE}/${CA_ID}/set-primary${query}`, { method: 'POST' }), accountParams)

  it('moves the primary through make_cash_account_primary and nothing else', async () => {
    const client = makeClient({ company_members: OWNER, rpc: { data: row({ is_primary: true }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ cash_account_id: CA_ID, is_primary: true })
    expect(client.rpc).toHaveBeenCalledWith('make_cash_account_primary', { p_company_id: COMPANY_ID, p_cash_account_id: CA_ID })
    expect(client.calls.some((c) => c.table === 'cash_accounts')).toBe(false)
  })

  it('403 FORBIDDEN for a member key, without calling the RPC', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    expect((await post()).status).toBe(403)
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('400 CASH_ACCOUNT_PRIMARY_INELIGIBLE when the RPC refuses', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        rpc: { data: null, error: { message: 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_sek' } },
      }),
    )
    const res = await post()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('CASH_ACCOUNT_PRIMARY_INELIGIBLE')
    expect(body.error.details.reason).toBe('not_sek')
  })

  it('a dry run applies the eligibility rule without calling the RPC', async () => {
    const eur = makeClient({
      company_members: OWNER,
      cash_accounts: { data: row({ currency: 'EUR', ledger_account: '1932' }), error: null },
    })
    mockServiceClient.mockReturnValue(eur)
    const refused = await post('?dry_run=true')
    expect(refused.status).toBe(400)
    expect((await refused.json()).error.details.reason).toBe('not_sek')
    expect(eur.rpc).not.toHaveBeenCalled()

    const sek = makeClient({ company_members: OWNER, cash_accounts: { data: row(), error: null } })
    mockServiceClient.mockReturnValue(sek)
    const ok = await post('?dry_run=true')
    expect(ok.status).toBe(200)
    expect((await ok.json()).data.preview).toEqual({ cash_account_id: CA_ID, ledger_account: '1931', already_primary: false })
    expect(wrote(sek)).toBe(false)
  })
})

describe('PUT /api/v1/companies/:companyId/cash-accounts/payee-defaults', () => {
  const put = (body: unknown, query = '') =>
    setPayeeDefault(request(`${BASE}/payee-defaults${query}`, { method: 'PUT', body: JSON.stringify(body) }), companyParams)

  it('400 on an unknown currency', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await put({ currency: 'JPY', cash_account_id: CA_ID })).status).toBe(400)
  })

  it('404 CASH_ACCOUNT_NOT_FOUND for an account outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, cash_accounts: { data: null, error: null } }))
    const res = await put({ currency: 'SEK', cash_account_id: CA_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
  })

  it('400 INVOICE_PAYEE_ACCOUNT_INVALID for a disabled account', async () => {
    const client = makeClient({ company_members: OWNER, cash_accounts: { data: row({ enabled: false }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await put({ currency: 'SEK', cash_account_id: CA_ID })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAYEE_ACCOUNT_INVALID')
    expect(body.error.details.reason).toBe('disabled')
    expect(wrote(client)).toBe(false)
  })

  it('upserts the default and answers every per-currency default', async () => {
    const client = makeClient({
      company_members: OWNER,
      cash_accounts: [{ data: row(), error: null }, { data: [row()], error: null }],
      invoice_payee_defaults: [
        { data: null, error: null },
        { data: [{ id: 'd1', company_id: COMPANY_ID, currency: 'SEK', cash_account_id: CA_ID }], error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await put({ currency: 'SEK', cash_account_id: CA_ID })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ defaults: [{ currency: 'SEK', cash_account_id: CA_ID }] })
    const upsert = client.calls.find((c) => c.table === 'invoice_payee_defaults' && c.method === 'upsert')
    expect(upsert?.args[0]).toEqual({ company_id: COMPANY_ID, currency: 'SEK', cash_account_id: CA_ID })
  })

  it('403 FORBIDDEN for a member key; a dry run writes nothing', async () => {
    const member = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(member)
    expect((await put({ currency: 'SEK', cash_account_id: null })).status).toBe(403)

    const owner = makeClient({ company_members: OWNER })
    mockServiceClient.mockReturnValue(owner)
    const res = await put({ currency: 'EUR', cash_account_id: null }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toEqual({ currency: 'EUR', cash_account_id: null, action: 'clear' })
    expect(wrote(owner)).toBe(false)
  })
})
