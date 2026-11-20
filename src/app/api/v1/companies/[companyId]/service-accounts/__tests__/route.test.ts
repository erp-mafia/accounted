/**
 * The v1 service-account doors:
 *
 *   GET  /service-accounts                          list
 *   POST /service-accounts                          create
 *   GET  /service-accounts/:id                      detail with keys
 *   POST /service-accounts/:id/revoke               revoke (keys follow)
 *   POST /service-accounts/:id/keys                 mint (secret once)
 *   POST /service-accounts/:id/keys/:keyId/revoke   revoke one key
 *
 * The rules the database holds (sponsor role, caps, the key binding, the
 * revocation cascade) are pinned in tests/pg/service-accounts.pg.test.ts.
 * Here: auth, scope, the person-key and owner/admin gate, validation, the
 * not-found answers, the scope cap and the secret-once contract.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
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

import { createServiceClientNoCookies, hashApiKey, validateApiKey } from '@/lib/auth/api-keys'
import { createTableMockSupabase, IDEMPOTENCY_CLAIM_RPC } from '@/tests/helpers'
import { GET as listAccounts, POST as createAccount } from '../route'
import { GET as getAccount } from '../[id]/route'
import { POST as revokeAccount } from '../[id]/revoke/route'
import { POST as mintKey } from '../[id]/keys/route'
import { POST as revokeKey } from '../[id]/keys/[keyId]/revoke/route'

const mockValidate = vi.mocked(validateApiKey)
const mockServiceClient = vi.mocked(createServiceClientNoCookies)

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SPONSOR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/service-accounts`

const ACCOUNT_ROW = {
  id: ACCOUNT_ID,
  company_id: COMPANY_ID,
  name: 'Nattlig fakturasynk',
  sponsor_user_id: SPONSOR_ID,
  created_by: USER_ID,
  created_at: '2026-10-16T08:00:00Z',
  revoked_at: null,
  revoked_by: null,
}

const KEY_ROW = {
  id: KEY_ID,
  name: 'Nattlig fakturasynk',
  key_prefix: 'gnubok_sk_abcdefgh',
  scopes: ['invoices:read'],
  mode: 'live',
  created_at: '2026-10-16T08:01:00Z',
  last_used_at: null,
  revoked_at: null,
  service_account_id: ACCOUNT_ID,
}

type Grant = {
  scopes?: string[]
  serviceAccount?: { id: string; name: string } | null
}

function authAs(grant: Grant = {}) {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_admin',
    apiKeyName: 'Admin key',
    scopes: (grant.scopes ?? ['service_accounts:manage', 'invoices:read', 'invoices:write']) as never,
    mode: 'live',
    unattendedCommitLimit: null,
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    serviceAccount: grant.serviceAccount ?? null,
  })
}

/**
 * company_members answers three readers: the wrapper's gate and the door's
 * gate (one row, the caller's role) and the status read (a list of sponsors).
 */
function db(options: { callerRole?: string; sponsorRole?: string | null } = {}) {
  const mock = createTableMockSupabase({
    company_members: (calls) =>
      calls.some((c) => c.method === 'in')
        ? { data: options.sponsorRole === null ? [] : [{ user_id: SPONSOR_ID, role: options.sponsorRole ?? 'admin' }] }
        : { data: { company_id: COMPANY_ID, role: options.callerRole ?? 'owner' } },
    companies: { data: { archived_at: null } },
  })
  mockServiceClient.mockReturnValue(mock.supabase as never)
  return mock
}

function request(path: string, init: RequestInit & { idempotencyKey?: string | null } = {}) {
  const { idempotencyKey = 'f1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...rest } = init
  return new Request(`${BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: 'Bearer gnubok_sk_test',
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...((rest.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const accountParams = (id = ACCOUNT_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })
const keyParams = (keyId = KEY_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id: ACCOUNT_ID, keyId }) })

beforeEach(() => {
  vi.clearAllMocks()
  authAs()
})

describe('the gate every service-account door runs', () => {
  it('answers 401 without a bearer token', async () => {
    db()
    const res = await listAccounts(new Request(BASE), companyParams)
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it('answers 403 SERVICE_ACCOUNT_SUSPENDED for a suspended account key, not a bare 401', async () => {
    db()
    mockValidate.mockResolvedValueOnce({
      error: 'Service account suspended',
      status: 403,
      code: 'SERVICE_ACCOUNT_SUSPENDED',
    })
    const res = await listAccounts(request(''), companyParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('SERVICE_ACCOUNT_SUSPENDED')
  })

  it('answers 403 INSUFFICIENT_SCOPE without service_accounts:manage', async () => {
    db()
    authAs({ scopes: ['invoices:read'] })
    const res = await listAccounts(request(''), companyParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it("refuses a service account's own key, even with the scope", async () => {
    db()
    authAs({ serviceAccount: { id: ACCOUNT_ID, name: 'Synk' } })
    const res = await listAccounts(request(''), companyParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('SERVICE_ACCOUNT_KEY_NOT_PERMITTED')
  })

  it('refuses an admin-scoped key held by a plain member', async () => {
    db({ callerRole: 'member' })
    const res = await listAccounts(request(''), companyParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('SERVICE_ACCOUNT_ADMIN_REQUIRED')
  })
})

describe('GET /service-accounts', () => {
  it('lists live accounts first, each with its status', async () => {
    const mock = db({ sponsorRole: 'member' })
    mock.setTable('service_accounts', {
      data: [
        { ...ACCOUNT_ROW, id: 'revoked-1', revoked_at: '2026-10-16T09:00:00Z', revoked_by: USER_ID },
        ACCOUNT_ROW,
      ],
    })
    const res = await listAccounts(request(''), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.service_accounts.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([
      // The sponsor is a plain member now: suspended, not active.
      [ACCOUNT_ID, 'suspended'],
      ['revoked-1', 'revoked'],
    ])
  })
})

describe('POST /service-accounts', () => {
  it('answers 400 for a missing or blank name', async () => {
    db()
    for (const body of [{}, { name: '   ' }, { name: 'x', sponsor_user_id: 'not-a-uuid' }]) {
      const res = await createAccount(request('', { method: 'POST', body: JSON.stringify(body) }), companyParams)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('creates the account sponsored by the caller, attributed to the calling key', async () => {
    const mock = db()
    mock.setTable('rpc:create_service_account', {
      data: { ...ACCOUNT_ROW, sponsor_user_id: USER_ID },
    })
    mock.setTable('company_members', (calls) =>
      calls.some((c) => c.method === 'in')
        ? { data: [{ user_id: USER_ID, role: 'owner' }] }
        : { data: { company_id: COMPANY_ID, role: 'owner' } },
    )
    const res = await createAccount(
      request('', { method: 'POST', body: JSON.stringify({ name: '  Nattlig fakturasynk ' }) }),
      companyParams,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({ id: ACCOUNT_ID, sponsor_user_id: USER_ID, status: 'active' })
    expect(mock.findCall('rpc:create_service_account', 'rpc')?.[0]).toEqual({
      p_company_id: COMPANY_ID,
      p_name: 'Nattlig fakturasynk',
      p_sponsor_user_id: USER_ID,
      p_created_by: USER_ID,
      p_actor_type: 'api_key',
      p_actor_label: 'Admin key',
    })
  })

  it('maps the database refusals to their codes', async () => {
    const cases: Array<[{ code?: string; message: string }, number, string]> = [
      [{ code: '23514', message: 'SERVICE_ACCOUNT_SPONSOR_INVALID: the sponsor must be an owner or admin' }, 422, 'SERVICE_ACCOUNT_SPONSOR_INVALID'],
      [{ code: '23505', message: 'duplicate key value violates unique constraint "service_accounts_live_name_key"' }, 409, 'SERVICE_ACCOUNT_NAME_TAKEN'],
      [{ code: '54000', message: 'SERVICE_ACCOUNT_LIMIT: a company has at most 25 live service accounts' }, 409, 'SERVICE_ACCOUNT_LIMIT'],
    ]
    for (const [error, status, code] of cases) {
      const mock = db()
      mock.setTable('rpc:create_service_account', { data: null, error: error as never })
      const res = await createAccount(
        request('', { method: 'POST', body: JSON.stringify({ name: 'Synk', sponsor_user_id: SPONSOR_ID }) }),
        companyParams,
      )
      expect(res.status, code).toBe(status)
      expect((await res.json()).error.code).toBe(code)
    }
  })
})

describe('GET /service-accounts/:id', () => {
  it('answers 404 for an account that is not the company\'s, 400 for a malformed id', async () => {
    db()
    const res = await getAccount(request(`/${ACCOUNT_ID}`), accountParams(ACCOUNT_ID))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SERVICE_ACCOUNT_NOT_FOUND')

    // A malformed id is refused by withApiV1 before the route runs (B08).
    const malformed = await getAccount(request('/not-a-uuid'), accountParams('not-a-uuid'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'id' } })
  })

  it('returns the account with its keys and their access, never a secret', async () => {
    const mock = db()
    mock.setTable('service_accounts', { data: ACCOUNT_ROW })
    mock.setTable('api_keys', { data: [KEY_ROW] })
    mock.setTable('api_key_companies', { data: [{ api_key_id: KEY_ID }] })
    const res = await getAccount(request(`/${ACCOUNT_ID}`), accountParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ id: ACCOUNT_ID, status: 'active' })
    expect(body.data.keys).toEqual([
      {
        id: KEY_ID,
        name: 'Nattlig fakturasynk',
        key_prefix: 'gnubok_sk_abcdefgh',
        scopes: ['invoices:read'],
        mode: 'live',
        access: 'read_only',
        created_at: '2026-10-16T08:01:00Z',
        last_used_at: null,
        revoked_at: null,
      },
    ])
    expect(JSON.stringify(body)).not.toContain('key_hash')
  })
})

describe('POST /service-accounts/:id/revoke', () => {
  it('answers 404 when the account is not the company\'s', async () => {
    const mock = db()
    // A NULL composite comes back from PostgREST as an object of nulls.
    mock.setTable('rpc:revoke_service_account', { data: { id: null, company_id: null } })
    const res = await revokeAccount(request(`/${ACCOUNT_ID}/revoke`, { method: 'POST' }), accountParams())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SERVICE_ACCOUNT_NOT_FOUND')
  })

  it('revokes the account as the calling key', async () => {
    const mock = db()
    mock.setTable('rpc:revoke_service_account', {
      data: { ...ACCOUNT_ROW, revoked_at: '2026-10-16T10:00:00Z', revoked_by: USER_ID },
    })
    const res = await revokeAccount(request(`/${ACCOUNT_ID}/revoke`, { method: 'POST' }), accountParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: 'revoked', revoked_by: USER_ID })
    expect(mock.findCall('rpc:revoke_service_account', 'rpc')?.[0]).toMatchObject({
      p_service_account_id: ACCOUNT_ID,
      p_revoked_by: USER_ID,
      p_actor_type: 'api_key',
    })
  })
})

describe('POST /service-accounts/:id/keys', () => {
  const mint = (body: unknown, idempotencyKey?: string | null) =>
    mintKey(
      request(`/${ACCOUNT_ID}/keys`, { method: 'POST', body: JSON.stringify(body), idempotencyKey }),
      accountParams(),
    )

  it('answers 400 for no scopes, an unknown scope, or service_accounts:manage', async () => {
    db()
    for (const body of [{}, { scopes: [] }, { scopes: ['bogus:read'] }, { scopes: ['service_accounts:manage'] }]) {
      const res = await mint(body)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('refuses a scope the calling key does not hold, naming it', async () => {
    const mock = db()
    const res = await mint({ scopes: ['invoices:read', 'payroll:write'] })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('SERVICE_ACCOUNT_SCOPE_NOT_HELD')
    expect(body.error.details.not_held).toEqual(['payroll:write'])
    expect(mock.findCall('rpc:create_service_account_key', 'rpc')).toBeUndefined()
  })

  it('asks for acknowledge_sod before a stage + approve key', async () => {
    db()
    authAs({ scopes: ['service_accounts:manage', 'invoices:write', 'pending_operations:approve'] })
    const res = await mint({ scopes: ['invoices:write', 'pending_operations:approve'] })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('API_KEY_SOD_CONFLICT')
  })

  it('maps a revoked or suspended account and the key cap to their codes', async () => {
    const cases: Array<[string, number]> = [
      ['SERVICE_ACCOUNT_NOT_FOUND', 404],
      ['SERVICE_ACCOUNT_REVOKED', 409],
      ['SERVICE_ACCOUNT_SUSPENDED', 403],
      ['SERVICE_ACCOUNT_KEY_LIMIT', 409],
    ]
    for (const [code, status] of cases) {
      const mock = db()
      mock.setTable('rpc:create_service_account_key', { data: null, error: { code: 'P0001', message: `${code}: refused` } as never })
      const res = await mint({ scopes: ['invoices:read'] })
      expect(res.status, code).toBe(status)
      expect((await res.json()).error.code).toBe(code)
    }
  })

  it('returns the secret once, stores only its hash, and never caches it under Idempotency-Key', async () => {
    const mock = db()
    mock.setTable('rpc:create_service_account_key', { data: KEY_ID })
    mock.setTable('api_keys', { data: [{ ...KEY_ROW, scopes: ['invoices:read', 'invoices:write'] }] })
    mock.setTable('api_key_companies', { data: [] })

    const res = await mint({ scopes: ['invoices:read', 'invoices:write'], name: 'Nyckel 1' }, 'f2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    const body = await res.json()
    expect(body.data).toMatchObject({
      id: KEY_ID,
      service_account_id: ACCOUNT_ID,
      access: 'read_write',
      scopes: ['invoices:read', 'invoices:write'],
    })
    expect(body.data.key).toMatch(/^gnubok_sk_/)

    const args = mock.findCall('rpc:create_service_account_key', 'rpc')?.[0] as Record<string, unknown>
    expect(args).toMatchObject({
      p_company_id: COMPANY_ID,
      p_service_account_id: ACCOUNT_ID,
      p_name: 'Nyckel 1',
      p_scopes: ['invoices:read', 'invoices:write'],
      p_mode: 'live',
      p_read_only: false,
      p_sod_acknowledged_at: null,
      p_created_by: USER_ID,
      p_actor_type: 'api_key',
      p_actor_label: 'Admin key',
    })
    expect(args.p_key_hash).toBe(hashApiKey(body.data.key))
    expect(JSON.stringify(args)).not.toContain(body.data.key)
    // The plaintext never reaches idempotency_keys.
    expect(mock.calls.some((c) => c.table === `rpc:${IDEMPOTENCY_CLAIM_RPC}`)).toBe(false)
    expect(mock.calls.some((c) => c.table === 'idempotency_keys')).toBe(false)
  })
})

describe('POST /service-accounts/:id/keys/:keyId/revoke', () => {
  it('answers 404 for a key that is not this account\'s, 400 for a malformed id', async () => {
    const mock = db()
    mock.setTable('rpc:revoke_service_account_key', { data: null })
    const res = await revokeKey(request(`/${ACCOUNT_ID}/keys/${KEY_ID}/revoke`, { method: 'POST' }), keyParams(KEY_ID))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SERVICE_ACCOUNT_KEY_NOT_FOUND')

    // A malformed id is refused by withApiV1 before the route runs (B08).
    const malformed = await revokeKey(request(`/${ACCOUNT_ID}/keys/nope/revoke`, { method: 'POST' }), keyParams('nope'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'keyId' } })
  })

  it('revokes the key as the calling key', async () => {
    const mock = db()
    mock.setTable('rpc:revoke_service_account_key', { data: '2026-10-16T10:00:00Z' })
    mock.setTable('api_keys', { data: [{ ...KEY_ROW, revoked_at: '2026-10-16T10:00:00Z' }] })
    mock.setTable('api_key_companies', { data: [] })
    const res = await revokeKey(request(`/${ACCOUNT_ID}/keys/${KEY_ID}/revoke`, { method: 'POST' }), keyParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ id: KEY_ID, revoked_at: '2026-10-16T10:00:00Z' })
    expect(mock.findCall('rpc:revoke_service_account_key', 'rpc')?.[0]).toMatchObject({
      p_service_account_id: ACCOUNT_ID,
      p_api_key_id: KEY_ID,
      p_revoked_by: USER_ID,
      p_actor_type: 'api_key',
    })
  })
})
