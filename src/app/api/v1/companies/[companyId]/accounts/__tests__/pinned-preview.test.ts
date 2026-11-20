/**
 * Pinned previews over v1 (lib/operations/preview-token.ts), on one real
 * operation: PATCH /accounts/:number (accounts.update), whose dry run reads
 * the account as it stands and previews the change against it.
 *
 * The contract: a dry run answers preview_token; a commit that sends it back
 * in Preview-Token books only while the recomputed dry run fingerprints the
 * same, and otherwise answers 409 PREVIEW_STALE with the fresh preview and
 * its token and writes nothing. A token cannot cross operations, companies
 * or inputs. Without the header nothing changes. The account table is
 * per-request mock state, so "another write landed" is the second request
 * reading a different row.
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

// An in-memory idempotency_keys table, so a 409 PREVIEW_STALE can be shown
// NOT to be cached under the key its retry reuses.
const idempotency = vi.hoisted(() => ({ store: new Map<string, { hash: string; status: string; body: unknown }>() }))
vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>('@/lib/api/idempotency')
  return {
    ...actual,
    checkIdempotencyKey: vi.fn(async (_s: unknown, _u: string, _c: string, key: string, hash: string) => {
      const hit = idempotency.store.get(key)
      if (!hit) return null
      if (hit.hash !== hash) throw new actual.IdempotencyKeyReuseError(key)
      return { status: hit.status, body: hit.body }
    }),
    storeIdempotencyResponse: vi.fn(
      async (_s: unknown, _u: string, _c: string, key: string, hash: string, status: string, body: unknown) => {
        idempotency.store.set(key, { hash, status, body })
      },
    ),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { GET as listAccounts } from '../route'
import { PATCH as updateAccount, DELETE as deleteAccount } from '../[number]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** The account as the dry run reads it (chart_of_accounts select). */
const CURRENT = {
  account_number: '6570',
  account_name: 'Bankkostnader',
  description: null,
  default_vat_code: null,
  default_vat_rate: null,
  default_vat_treatment: null,
  vat_box: null,
  sru_code: '7522',
  is_active: true,
}
/** The row the commit's update answers. */
const UPDATED = {
  id: '8d0e0000-0000-4000-8000-000000000000',
  account_number: '6570',
  account_name: 'Bankavgifter',
  account_class: 6,
  account_group: '65',
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
  sru_code: '7522',
  sort_order: 6570,
}
const BODY = { account_name: 'Bankavgifter' }

/**
 * One request's database: every company is one the key's user owns, and
 * chart_of_accounts answers its queue in order (dry-run read first, then
 * the commit's update).
 */
function db(chart: TableMockResult[]) {
  const mock = createTableMockSupabase({
    company_members: (calls) => {
      const companyId = calls.find((c) => c.method === 'eq' && c.args[0] === 'company_id')?.args[1] ?? COMPANY_A
      return { data: { company_id: companyId, role: 'owner' } }
    },
    chart_of_accounts: chart,
    pending_operations: (calls) => {
      const insert = calls.find((c) => c.method === 'insert')
      return {
        data: insert
          ? { id: '33333333-3333-4333-8333-333333333333', status: 'pending', created_at: '2026-10-15T10:00:00.000Z', ...(insert.args[0] as object) }
          : null,
      }
    },
  })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

const chartUpdates = (mock: ReturnType<typeof db>) => mock.payloads('chart_of_accounts', 'update')

function patch(
  options: { company?: string; body?: unknown; query?: string; token?: string; key?: string; number?: string } = {},
) {
  const company = options.company ?? COMPANY_A
  const number = options.number ?? '6570'
  const request = new Request(`https://x.test/api/v1/companies/${company}/accounts/${number}${options.query ?? ''}`, {
    method: 'PATCH',
    body: JSON.stringify(options.body ?? BODY),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': options.key ?? crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...(options.token !== undefined ? { 'Preview-Token': options.token } : {}),
    },
  })
  return updateAccount(request, { params: Promise.resolve({ companyId: company, number }) })
}

/** A dry run of PATCH against `current`; answers the token it issued. */
async function dryRunToken(current: Record<string, unknown> = CURRENT, options: { company?: string; body?: unknown } = {}) {
  db([{ data: current }])
  const res = await patch({ ...options, query: '?dry_run=true' })
  expect(res.status).toBe(200)
  const { data } = await res.json()
  return data.preview_token as string
}

function auth(mode: 'live' | 'test' = 'live') {
  return {
    userId: 'user-1',
    companyId: COMPANY_A,
    apiKeyId: 'ak_1',
    apiKeyName: 'Agent key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode,
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    unattendedCommitLimit: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  idempotency.store.clear()
  mockValidate.mockResolvedValue(auth())
})

describe('PATCH /accounts/:number with a pinned preview', () => {
  it('a dry run answers the preview and its token, and writes nothing', async () => {
    const mock = db([{ data: CURRENT }])
    const res = await patch({ query: '?dry_run=true' })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const { data } = await res.json()
    expect(data).toMatchObject({
      dry_run: true,
      preview: { account_number: '6570', current: CURRENT, changes: { account_name: 'Bankavgifter' } },
    })
    expect(data.preview_token).toMatch(/^pv1\.[A-Za-z0-9_-]{43}$/)
    expect(chartUpdates(mock)).toHaveLength(0)
  })

  it('the same dry run twice answers the same token', async () => {
    expect(await dryRunToken()).toBe(await dryRunToken())
  })

  it('commit with the token while nothing changed: books it, exactly once', async () => {
    const token = await dryRunToken()
    const mock = db([{ data: CURRENT }, { data: UPDATED }])

    const res = await patch({ token })

    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ account_number: '6570', account_name: 'Bankavgifter' })
    expect(chartUpdates(mock)).toEqual([{ account_name: 'Bankavgifter' }])
  })

  it('commit after another write changed the account: 409 PREVIEW_STALE with the fresh preview and token, nothing written', async () => {
    const token = await dryRunToken()
    // Meanwhile the account was deactivated.
    const moved = { ...CURRENT, is_active: false }
    const mock = db([{ data: moved }, { data: UPDATED }])

    const res = await patch({ token })

    expect(res.status).toBe(409)
    const { error } = await res.json()
    expect(error.code).toBe('PREVIEW_STALE')
    expect(error.details.preview).toMatchObject({ current: moved, changes: { account_name: 'Bankavgifter' } })
    expect(error.details.preview_token).not.toBe(token)
    // The fresh token is exactly what a dry run in the new state issues.
    expect(error.details.preview_token).toBe(await dryRunToken(moved))
    expect(chartUpdates(mock)).toHaveLength(0)
  })

  it('the fresh token from the 409 commits, under the same Idempotency-Key: the refusal is not cached', async () => {
    const key = crypto.randomUUID()
    const stale = await dryRunToken()
    const moved = { ...CURRENT, default_vat_rate: 0.25 }

    db([{ data: moved }])
    const refused = await patch({ token: stale, key })
    expect(refused.status).toBe(409)
    const fresh = (await refused.json()).error.details.preview_token as string
    expect(idempotency.store.has(key)).toBe(false)

    const mock = db([{ data: moved }, { data: UPDATED }])
    const committed = await patch({ token: fresh, key })
    expect(committed.status).toBe(200)
    expect(committed.headers.get('Idempotent-Replayed')).toBeNull()
    expect(chartUpdates(mock)).toHaveLength(1)
  })

  it('a token never crosses companies: the same request in another company is refused, nothing written', async () => {
    const token = await dryRunToken(CURRENT, { company: COMPANY_A })
    const mock = db([{ data: CURRENT }, { data: UPDATED }])

    const res = await patch({ company: COMPANY_B, token })

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PREVIEW_STALE')
    expect(chartUpdates(mock)).toHaveLength(0)
  })

  it('a token never crosses operations: PATCH\'s token on DELETE of the same account is refused, nothing deleted', async () => {
    const token = await dryRunToken()
    const mock = db([{ data: { id: UPDATED.id, account_number: '6570', is_system_account: false } }])
    const request = new Request(`https://x.test/api/v1/companies/${COMPANY_A}/accounts/6570`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': crypto.randomUUID(),
        'Preview-Token': token,
      },
    })

    const res = await deleteAccount(request, { params: Promise.resolve({ companyId: COMPANY_A, number: '6570' }) })

    // The delete's own dry run passes (an unused account), and its
    // fingerprint is not PATCH's.
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PREVIEW_STALE')
    expect(mock.findCalls('chart_of_accounts', 'delete')).toHaveLength(0)
  })

  it('a token never crosses inputs: another body is refused, nothing written', async () => {
    const token = await dryRunToken()
    const mock = db([{ data: CURRENT }, { data: UPDATED }])

    const res = await patch({ token, body: { account_name: 'Något annat' } })

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PREVIEW_STALE')
    expect(chartUpdates(mock)).toHaveLength(0)
  })

  it('without the header nothing changes: the commit runs once, no preview read first', async () => {
    const mock = db([{ data: UPDATED }])
    const res = await patch()
    expect(res.status).toBe(200)
    expect(chartUpdates(mock)).toHaveLength(1)
    expect(mock.payloads('chart_of_accounts', 'select')).toHaveLength(1)
  })

  it('400 for a malformed token, running nothing', async () => {
    for (const token of ['', 'not-a-token', 'pv1.short']) {
      const mock = db([{ data: CURRENT }, { data: UPDATED }])
      const res = await patch({ token })
      expect(res.status).toBe(400)
      expect((await res.json()).error.details.issues[0].field).toBe('Preview-Token')
      expect(mock.findCalls('chart_of_accounts', 'select')).toHaveLength(0)
    }
  })

  it('400 for the header on an endpoint that cannot check it: never silently ignored', async () => {
    const token = await dryRunToken()
    db([{ data: [] }])
    const res = await listAccounts(
      new Request(`https://x.test/api/v1/companies/${COMPANY_A}/accounts`, {
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key', 'Preview-Token': token },
      }),
      { params: Promise.resolve({ companyId: COMPANY_A }) },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.issues[0].field).toBe('Preview-Token')
  })

  it('a test key (forced dry run) checks the token too and answers the same one while it holds', async () => {
    const token = await dryRunToken()
    mockValidate.mockResolvedValue(auth('test'))
    const mock = db([{ data: CURRENT }])
    const res = await patch({ token })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ dry_run: true, preview_token: token })
    expect(chartUpdates(mock)).toHaveLength(0)
  })

  it('?stage=true with the token stages while it holds, and stages nothing once stale', async () => {
    const token = await dryRunToken()

    let mock = db([{ data: CURRENT }])
    const staged = await patch({ token, query: '?stage=true' })
    expect(staged.status).toBe(202)
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(1)

    mock = db([{ data: { ...CURRENT, account_name: 'Bank' } }])
    const refused = await patch({ token, query: '?stage=true' })
    expect(refused.status).toBe(409)
    const { error } = await refused.json()
    expect(error.code).toBe('PREVIEW_STALE')
    expect(error.details.preview).toMatchObject({ current: { account_name: 'Bank' } })
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('advertises the pin in the spec: x-preview-token-supported on operation writes only', async () => {
    const { generateOpenApiSpec } = await import('@/lib/api/v1/registry')
    const spec = generateOpenApiSpec('https://x.test')
    const path = spec.paths['/api/v1/companies/{companyId}/accounts/{number}']
    expect((path.patch as Record<string, unknown>)['x-preview-token-supported']).toBe(true)
    expect((spec.paths['/api/v1/companies/{companyId}/accounts'].get as Record<string, unknown>)['x-preview-token-supported']).toBeUndefined()
  })
})
