/**
 * "Dela upp IB per projekt" (#3313) through the v1 door of the operation
 * registry (src/lib/operations/opening-balances.ts via lib/operations/v1.ts):
 *   GET  /api/v1/companies/:companyId/fiscal-periods/:id/opening-balances/split-per-project
 *   POST same path (?dry_run=true previews)
 *
 * The rules are the service's, unit-tested in
 * lib/import/opening-balance/__tests__/split-per-project.test.ts; here the
 * door: scopes, validation, path mapping, and the outcome in the v1 envelope.
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

const previewMock = vi.fn()
const splitMock = vi.fn()
vi.mock('@/lib/import/opening-balance/split-per-project', async () => {
  const actual = await vi.importActual<typeof import('@/lib/import/opening-balance/split-per-project')>(
    '@/lib/import/opening-balance/split-per-project',
  )
  return {
    ...actual,
    previewOpeningBalanceSplit: (...args: unknown[]) => previewMock(...args),
    splitOpeningBalancesPerProject: (...args: unknown[]) => splitMock(...args),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET, POST } from '../split-per-project/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/fiscal-periods/${PERIOD_ID}/opening-balances/split-per-project`
const params = (id = PERIOD_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

/**
 * Membership lookups answer "owner"; every other table (the idempotency
 * cache included) answers nothing: the service is mocked.
 */
function client() {
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve(
                table === 'company_members'
                  ? { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
                  : { data: null, error: null },
              )
          }
          return () => chain(table)
        },
      },
    )
  return { from: vi.fn((table: string) => chain(table)), rpc: vi.fn(() => chain('rpc')) }
}

function request(method: 'GET' | 'POST', query = '', body?: unknown): Request {
  return new Request(`${URL_BASE}${query}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' } : {}),
    },
  })
}

const PREVIEW = { fiscal_period_id: PERIOD_ID, accounts_to_change: 1, can_apply: true, fingerprint: 'f1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write', 'reports:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(client())
})

describe('GET .../opening-balances/split-per-project', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await GET(request('GET'), params())).status).toBe(401)
    expect(previewMock).not.toHaveBeenCalled()
  })

  it('403 without reports:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    expect((await GET(request('GET'), params())).status).toBe(403)
  })

  it('400 for a malformed fiscal period id', async () => {
    const res = await GET(request('GET'), params('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(previewMock).not.toHaveBeenCalled()
  })

  it('404 OB_PERIOD_NOT_FOUND for a year outside the company', async () => {
    previewMock.mockResolvedValue({ ok: false, code: 'OB_PERIOD_NOT_FOUND' })
    const res = await GET(request('GET'), params())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('OB_PERIOD_NOT_FOUND')
  })

  it('200 with the preview, for the path\'s year and the key\'s company', async () => {
    previewMock.mockResolvedValue({ ok: true, data: PREVIEW })
    const res = await GET(request('GET'), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject(PREVIEW)
    const [ctx, input] = previewMock.mock.calls[0] as [{ companyId: string }, unknown]
    expect(ctx.companyId).toBe(COMPANY_ID)
    expect(input).toEqual({ fiscal_period_id: PERIOD_ID })
  })
})

describe('POST .../opening-balances/split-per-project', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await POST(request('POST', '', {}), params())).status).toBe(401)
    expect(splitMock).not.toHaveBeenCalled()
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    expect((await POST(request('POST', '', {}), params())).status).toBe(403)
    expect(splitMock).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR for an empty fingerprint', async () => {
    const res = await POST(request('POST', '', { expected_fingerprint: '' }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('applies with the pinned fingerprint', async () => {
    splitMock.mockResolvedValue({
      ok: true,
      data: {
        fiscal_period_id: PERIOD_ID,
        journal_entry_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        applied: true,
        accounts_changed: ['1470'],
        accounts_skipped: [],
        lines_struck: 1,
        lines_added: 3,
        rattelse_log_ids: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
        fingerprint: 'f1',
      },
    })
    const res = await POST(request('POST', '', { expected_fingerprint: 'f1' }), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ applied: true, accounts_changed: ['1470'] })
    expect(splitMock.mock.calls[0][1]).toEqual({ fiscal_period_id: PERIOD_ID, expected_fingerprint: 'f1' })
    expect(splitMock.mock.calls[0][2]).toEqual({ dryRun: false })
  })

  it('?dry_run=true answers the preview envelope', async () => {
    splitMock.mockResolvedValue({ ok: true, dryRun: true, preview: PREVIEW })
    const res = await POST(request('POST', '?dry_run=true', {}), params())
    expect(res.status).toBe(200)
    expect(splitMock.mock.calls[0][2]).toEqual({ dryRun: true })
    expect(JSON.stringify(await res.json())).toContain('"accounts_to_change":1')
  })

  it('409 OB_SPLIT_PERIOD_LOCKED for a locked year, with the remediation', async () => {
    splitMock.mockResolvedValue({ ok: false, code: 'OB_SPLIT_PERIOD_LOCKED' })
    const res = await POST(request('POST', '', {}), params())
    expect(res.status).toBe(409)
    const { error } = await res.json()
    expect(error.code).toBe('OB_SPLIT_PERIOD_LOCKED')
  })
})
