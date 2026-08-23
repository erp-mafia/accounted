/**
 * Tests for the account-keyed reconciliation v1 routes:
 *   GET    .../reconciliation/accounts
 *   GET    .../reconciliation/accounts/{accountKey}
 *   GET    .../reconciliation/accounts/{accountKey}/items
 *   POST   .../reconciliation/accounts/{accountKey}/links
 *   DELETE .../reconciliation/accounts/{accountKey}/links/{linkId}
 *   POST   .../reconciliation/accounts/{accountKey}/items/{itemId}/ignore
 *
 * Exercises the real withApiV1 wrapper (auth, scope, company membership,
 * idempotency, dry-run) with the service layer mocked.
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

const { listAccountsMock, statusMock, itemsMock, matchMock, unmatchMock, ignoreMock } = vi.hoisted(() => ({
  listAccountsMock: vi.fn(),
  statusMock: vi.fn(),
  itemsMock: vi.fn(),
  matchMock: vi.fn(),
  unmatchMock: vi.fn(),
  ignoreMock: vi.fn(),
}))

vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: listAccountsMock,
  getAccountStatus: statusMock,
}))
vi.mock('@/lib/reconciliation/items', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/items')>('@/lib/reconciliation/items')
  return { ...actual, listAccountItems: itemsMock }
})
vi.mock('@/lib/reconciliation/actions', () => ({
  matchPairs: matchMock,
  unmatchLink: unmatchMock,
  setItemIgnored: ignoreMock,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listGET } from '../route'
import { GET as statusGET } from '../[accountKey]/route'
import { GET as itemsGET } from '../[accountKey]/items/route'
import { POST as linksPOST } from '../[accountKey]/links/route'
import { DELETE as linkDELETE } from '../[accountKey]/links/[linkId]/route'
import { POST as ignorePOST } from '../[accountKey]/items/[itemId]/ignore/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
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
const CASH = '11111111-1111-4111-8111-111111111111'
const ROW = '22222222-2222-4222-8222-222222222222'
const ENTRY = '33333333-3333-4333-8333-333333333333'
const BASE = `http://localhost/api/v1/companies/${COMPANY_ID}/reconciliation/accounts`

function req(url: string, init: { method?: string; body?: unknown; idem?: boolean; dryRun?: boolean } = {}): Request {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-fixture-not-a-real-key',
    'Content-Type': 'application/json',
  }
  if (init.idem !== false && init.method && init.method !== 'GET') headers['Idempotency-Key'] = `idem-${Math.random().toString(36).slice(2)}-aaaa-4abc-8def-1234567890ab`
  if (init.dryRun) headers['X-Dry-Run'] = 'true'
  return new Request(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

function authOk(scopes: string[]) {
  mockValidate.mockResolvedValue({
    valid: true,
    userId: 'user-1',
    keyId: 'key-1',
    keyName: 'Test key',
    scopes,
    mode: 'live',
  })
}

// Dynamic-route params for the handlers under test; `never` keeps each
// handler's own params type while letting one helper serve all of them.
const params = (extra: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ companyId: COMPANY_ID, ...extra }) }) as never

describe('v1 reconciliation accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { role: 'owner' } },
        idempotency_keys: { data: null },
      }),
    )
    listAccountsMock.mockResolvedValue([{ account_key: 'skattekonto', kind: 'skattekonto' }])
    statusMock.mockResolvedValue({ account_key: 'skattekonto', kind: 'skattekonto', items: { proposed: [] }, bridge: [] })
    itemsMock.mockResolvedValue({ items: [], count: 0, total_count: 0, has_more: false, older_unmatched_count: 0 })
    matchMock.mockResolvedValue({ dry_run: false, considered: 1, applied: [{ external_id: ROW, journal_entry_id: ENTRY }], skipped: [] })
    unmatchMock.mockResolvedValue({ external_id: ROW, previous_journal_entry_id: ENTRY })
    ignoreMock.mockResolvedValue({ external_id: ROW, is_ignored: true })
  })

  it('401 without a valid key', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    const res = await listGET(req(BASE), params())
    expect(res.status).toBe(401)
  })

  it('403 INSUFFICIENT_SCOPE when the key lacks reconciliation:read', async () => {
    authOk(['transactions:read'])
    const res = await listGET(req(BASE), params())
    expect(res.status).toBe(403)
  })

  it('GET accounts returns the list', async () => {
    authOk(['reconciliation:read'])
    const res = await listGET(req(`${BASE}?with_status=false`), params())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.accounts[0].account_key).toBe('skattekonto')
    expect(listAccountsMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, expect.objectContaining({ withStatus: false }))
  })

  it('GET accounts rejects a malformed date with VALIDATION_ERROR', async () => {
    authOk(['reconciliation:read'])
    const res = await listGET(req(`${BASE}?date_from=20260101`), params())
    expect(res.status).toBe(400)
  })

  it('GET status strips the item lists and 404s an unknown account key', async () => {
    authOk(['reconciliation:read'])
    const ok = await statusGET(req(`${BASE}/skattekonto`), params({ accountKey: 'skattekonto' }))
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.data.items).toBeUndefined()
    expect(body.data.bridge).toEqual([])

    const bad = await statusGET(req(`${BASE}/1930`), params({ accountKey: '1930' }))
    expect(bad.status).toBe(404)

    statusMock.mockResolvedValueOnce(null)
    const missing = await statusGET(req(`${BASE}/bank:${CASH}`), params({ accountKey: `bank:${CASH}` }))
    expect(missing.status).toBe(404)
  })

  it('GET items pages through an opaque cursor and validates the bucket', async () => {
    authOk(['reconciliation:read'])
    itemsMock.mockResolvedValue({ items: [{ item_id: ROW }], count: 1, total_count: 3, has_more: true, next_offset: 1, older_unmatched_count: 0 })
    const res = await itemsGET(req(`${BASE}/skattekonto/items?bucket=proposed&limit=1`), params({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.next_cursor).toBeTruthy()
    expect(itemsMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'skattekonto', expect.objectContaining({ bucket: 'proposed', limit: 1, offset: 0 }))

    const page2 = await itemsGET(req(`${BASE}/skattekonto/items?cursor=${body.data.next_cursor}`), params({ accountKey: 'skattekonto' }))
    expect(page2.status).toBe(200)
    expect(itemsMock).toHaveBeenLastCalledWith(expect.anything(), COMPANY_ID, 'skattekonto', expect.objectContaining({ offset: 1 }))

    const bad = await itemsGET(req(`${BASE}/skattekonto/items?bucket=nope`), params({ accountKey: 'skattekonto' }))
    expect(bad.status).toBe(400)
  })

  it('POST links requires reconciliation:write and an Idempotency-Key, applies, and previews on dry run', async () => {
    authOk(['reconciliation:read'])
    const forbidden = await linksPOST(req(`${BASE}/skattekonto/links`, { method: 'POST', body: { use_proposals: true } }), params({ accountKey: 'skattekonto' }))
    expect(forbidden.status).toBe(403)

    authOk(['reconciliation:write'])
    const noIdem = await linksPOST(req(`${BASE}/skattekonto/links`, { method: 'POST', body: { use_proposals: true }, idem: false }), params({ accountKey: 'skattekonto' }))
    expect(noIdem.status).toBe(400)

    const invalid = await linksPOST(req(`${BASE}/skattekonto/links`, { method: 'POST', body: {} }), params({ accountKey: 'skattekonto' }))
    expect(invalid.status).toBe(400)

    const applied = await linksPOST(
      req(`${BASE}/skattekonto/links`, { method: 'POST', body: { pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }] } }),
      params({ accountKey: 'skattekonto' }),
    )
    expect(applied.status).toBe(200)
    expect(matchMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', 'skattekonto', expect.objectContaining({ pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }] }), { dryRun: false })

    const preview = await linksPOST(
      req(`${BASE}/skattekonto/links`, { method: 'POST', body: { use_proposals: true }, dryRun: true }),
      params({ accountKey: 'skattekonto' }),
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get('X-Dry-Run')).toBe('true')
    expect(matchMock).toHaveBeenLastCalledWith(expect.anything(), COMPANY_ID, 'user-1', 'skattekonto', expect.anything(), { dryRun: true })
  })

  it('DELETE link unmatches and 404s a non-uuid link id', async () => {
    authOk(['reconciliation:write'])
    const ok = await linkDELETE(req(`${BASE}/skattekonto/links/${ROW}`, { method: 'DELETE' }), params({ accountKey: 'skattekonto', linkId: ROW }))
    expect(ok.status).toBe(200)
    expect(unmatchMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', 'skattekonto', ROW)
    const bad = await linkDELETE(req(`${BASE}/skattekonto/links/abc`, { method: 'DELETE' }), params({ accountKey: 'skattekonto', linkId: 'abc' }))
    expect(bad.status).toBe(404)
  })

  it('POST ignore defaults to ignored: true and accepts an explicit restore', async () => {
    authOk(['reconciliation:write'])
    const res = await ignorePOST(req(`${BASE}/skattekonto/items/${ROW}/ignore`, { method: 'POST' }), params({ accountKey: 'skattekonto', itemId: ROW }))
    expect(res.status).toBe(200)
    expect(ignoreMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'skattekonto', ROW, true)
    await ignorePOST(req(`${BASE}/skattekonto/items/${ROW}/ignore`, { method: 'POST', body: { ignored: false } }), params({ accountKey: 'skattekonto', itemId: ROW }))
    expect(ignoreMock).toHaveBeenLastCalledWith(expect.anything(), COMPANY_ID, 'skattekonto', ROW, false)
  })
})
