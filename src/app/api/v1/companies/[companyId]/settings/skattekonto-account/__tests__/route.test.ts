/**
 * The skattekonto's ledger account through the v1 door (PH 175, issue #50):
 *   GET   /api/v1/companies/:companyId/settings/skattekonto-account  settings.get-skattekonto-account
 *   PATCH /api/v1/companies/:companyId/settings/skattekonto-account  settings.update-skattekonto-account
 *
 * The rules (owner/admin gate, 2012 for an enskild firma only, chart
 * activation, nothing moved in the ledger) are pinned by
 * lib/skatteverket/__tests__/skattekonto-account-service.test.ts. Here: auth,
 * scope, validation, the idempotency key, the dry run reaching the service,
 * and the service's refusals reaching the client with their codes.
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
const service = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
vi.mock('@/lib/skatteverket/skattekonto-account-service', () => ({
  getSkattekontoAccountState: service.get,
  setSkattekontoAccount: service.set,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET, PATCH } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/settings/skattekonto-account`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

/** company_members answers the owner; every other table nothing (the service itself is mocked). */
function client() {
  return createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'owner' } } }).supabase
}

const STATE = {
  entity_type: 'enskild_firma',
  account: '1630',
  chosen: null,
  choices: ['1630', '2012'],
  books_suggest: '1630',
  as_of: '2026-10-26',
  balances: [
    { account: '1630', balance: 1250 },
    { account: '2012', balance: 0 },
  ],
}

function request(url: string, init: RequestInit = {}, idempotency = true): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...(idempotency ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      'Content-Type': 'application/json',
    },
  })
}
const patch = (url: string, body: unknown, idempotency = true) =>
  request(url, { method: 'PATCH', body: JSON.stringify(body) }, idempotency)

function withScopes(scopes: string[]) {
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes,
    mode: 'live',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  withScopes(['companies:read', 'companies:write'])
  mockServiceClient.mockReturnValue(client())
  service.get.mockResolvedValue({ ok: true, data: STATE })
  service.set.mockResolvedValue({
    ok: true,
    data: { state: { ...STATE, account: '2012', chosen: '2012' }, previous_account: '1630', left_on_previous: 1250 },
  })
})

describe('GET /api/v1/companies/:companyId/settings/skattekonto-account', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await GET(request(URL_), params)
    expect(res.status).toBe(401)
    expect(service.get).not.toHaveBeenCalled()
  })

  it('403 without companies:read', async () => {
    withScopes(['reports:read'])
    const res = await GET(request(URL_), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns the account in use, the choices and their balances', async () => {
    const res = await GET(request(URL_), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(STATE)
  })

  it('404 when the service finds no settings row', async () => {
    service.get.mockResolvedValue({ ok: false, code: 'NOT_FOUND' })
    const res = await GET(request(URL_), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })
})

describe('PATCH /api/v1/companies/:companyId/settings/skattekonto-account', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await PATCH(patch(URL_, { account: '2012' }), params)
    expect(res.status).toBe(401)
    expect(service.set).not.toHaveBeenCalled()
  })

  it('403 INSUFFICIENT_SCOPE without companies:write', async () => {
    withScopes(['companies:read'])
    const res = await PATCH(patch(URL_, { account: '2012' }), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error.details.required_scope).toBe('companies:write')
  })

  it('400 for another account, an unknown field, or no Idempotency-Key, with nothing stored', async () => {
    for (const body of [{ account: '1930' }, { account: '2012', extra: true }, {}]) {
      const res = await PATCH(patch(URL_, body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
    const noKey = await PATCH(patch(URL_, { account: '2012' }, false), params)
    expect(noKey.status).toBe(400)
    expect(service.set).not.toHaveBeenCalled()
  })

  it('stores the choice and answers the new state and what is left on the old account', async () => {
    const res = await PATCH(patch(URL_, { account: '2012' }), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      state: { ...STATE, account: '2012', chosen: '2012' },
      previous_account: '1630',
      left_on_previous: 1250,
    })
    expect(service.set).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }), '2012', { dryRun: false })
  })

  it('a dry run reaches the service as one', async () => {
    service.set.mockResolvedValue({
      ok: true,
      dryRun: true,
      preview: { account: '2012', previous_account: '1630', left_on_previous: 1250 },
    })
    const res = await PATCH(patch(`${URL_}?dry_run=true`, { account: '2012' }), params)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(service.set).toHaveBeenCalledWith(expect.anything(), '2012', { dryRun: true })
  })

  it('passes the service refusals through: 2012 outside an enskild firma, a member who is not owner or admin', async () => {
    service.set.mockResolvedValue({
      ok: false,
      code: 'SKATTEKONTO_ACCOUNT_NOT_ALLOWED',
      details: { account: '2012', allowed: ['1630'], entity_type: 'aktiebolag' },
    })
    const refused = await PATCH(patch(URL_, { account: '2012' }), params)
    expect(refused.status).toBe(400)
    const body = await refused.json()
    expect(body.error.code).toBe('SKATTEKONTO_ACCOUNT_NOT_ALLOWED')
    expect(body.error.details.allowed).toEqual(['1630'])

    service.set.mockResolvedValue({ ok: false, code: 'FORBIDDEN', messageSv: 'Bara ägare eller administratör.' })
    const forbidden = await PATCH(patch(URL_, { account: '1630' }), params)
    expect(forbidden.status).toBe(403)
  })
})
