/**
 * Tests for the v1 sign-off routes:
 *   GET  .../reconciliation/accounts/{accountKey}/signoff
 *   POST .../reconciliation/accounts/{accountKey}/signoff
 *   POST .../reconciliation/accounts/{accountKey}/signoff/{signoffId}/reopen
 *
 * Real withApiV1 wrapper (auth, scope, membership, idempotency, dry-run);
 * the policy layer is mocked.
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

const { signMock, reopenMock, listMock } = vi.hoisted(() => ({
  signMock: vi.fn(),
  reopenMock: vi.fn(),
  listMock: vi.fn(),
}))

vi.mock('@/lib/reconciliation/signoff', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/signoff')>('@/lib/reconciliation/signoff')
  return { ...actual, signOffAccount: signMock, reopenSignoff: reopenMock }
})
vi.mock('@/lib/reconciliation/signoff-store', () => ({ listSignoffs: listMock }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ReconciliationSignoffError } from '@/lib/reconciliation/signoff'
import { GET as listGET, POST as signPOST } from '../[accountKey]/signoff/route'
import { POST as reopenPOST } from '../[accountKey]/signoff/[signoffId]/reopen/route'

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
const SIGNOFF_ID = '77777777-7777-4777-8777-777777777777'
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

const params = (extra: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ companyId: COMPANY_ID, ...extra }) }) as never

describe('v1 reconciliation sign-off', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { role: 'owner' } },
        idempotency_keys: { data: null },
      }),
    )
    listMock.mockResolvedValue([{ id: SIGNOFF_ID, account_key: 'skattekonto', through_date: '2026-07-31' }])
    signMock.mockResolvedValue({ dry_run: false, signoff: { id: SIGNOFF_ID, account_key: 'skattekonto', through_date: '2026-07-31' } })
    reopenMock.mockResolvedValue({ id: SIGNOFF_ID, account_key: 'skattekonto', through_date: '2026-07-31', reopened_at: '2026-08-24T08:00:00Z' })
  })

  it('401 without a valid key', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    const res = await listGET(req(`${BASE}/skattekonto/signoff`), params({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(401)
  })

  it('GET history needs reconciliation:read and passes include_reopened through', async () => {
    authOk(['reconciliation:signoff'])
    const forbidden = await listGET(req(`${BASE}/skattekonto/signoff`), params({ accountKey: 'skattekonto' }))
    expect(forbidden.status).toBe(403)

    authOk(['reconciliation:read'])
    const res = await listGET(req(`${BASE}/skattekonto/signoff?include_reopened=true&limit=10`), params({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.signoffs[0].id).toBe(SIGNOFF_ID)
    expect(listMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'skattekonto', { limit: 10, includeReopened: true })
  })

  it('POST signoff needs reconciliation:signoff (write alone is not enough) and an Idempotency-Key', async () => {
    authOk(['reconciliation:write'])
    const forbidden = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-07-31' } }), params({ accountKey: 'skattekonto' }))
    expect(forbidden.status).toBe(403)

    authOk(['reconciliation:signoff'])
    const noIdem = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-07-31' }, idem: false }), params({ accountKey: 'skattekonto' }))
    expect(noIdem.status).toBe(400)

    const invalid = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-7-1' } }), params({ accountKey: 'skattekonto' }))
    expect(invalid.status).toBe(400)
    expect(signMock).not.toHaveBeenCalled()

    const ok = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-07-31', note: 'ok' } }), params({ accountKey: 'skattekonto' }))
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.data.signoff.id).toBe(SIGNOFF_ID)
    expect(signMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      'skattekonto',
      { through_date: '2026-07-31', note: 'ok', force: undefined, external_balance: null },
      { dryRun: false },
    )
  })

  it('POST signoff dry-runs through the X-Dry-Run header', async () => {
    authOk(['reconciliation:signoff'])
    signMock.mockResolvedValue({ dry_run: true, would_sign: { account_key: 'skattekonto', through_date: '2026-07-31', is_reconciled: true } })
    const res = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-07-31' }, dryRun: true }), params({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(200)
    expect(signMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', 'skattekonto', expect.anything(), { dryRun: true })
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
  })

  it('POST signoff maps refusals: NOT_RECONCILED -> 400 VALIDATION_ERROR, ALREADY_SIGNED_OFF -> 409 CONFLICT, null -> 404', async () => {
    authOk(['reconciliation:signoff'])
    signMock.mockRejectedValueOnce(new ReconciliationSignoffError('oförklarat', 'NOT_RECONCILED'))
    const refused = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-07-31' } }), params({ accountKey: 'skattekonto' }))
    expect(refused.status).toBe(400)
    const refusedBody = await refused.json()
    expect(refusedBody.error.code).toBe('VALIDATION_ERROR')
    expect(refusedBody.error.details.code).toBe('NOT_RECONCILED')

    signMock.mockRejectedValueOnce(new ReconciliationSignoffError('redan', 'ALREADY_SIGNED_OFF'))
    const conflict = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-07-31' } }), params({ accountKey: 'skattekonto' }))
    expect(conflict.status).toBe(409)

    signMock.mockResolvedValueOnce(null)
    const missing = await signPOST(req(`${BASE}/skattekonto/signoff`, { method: 'POST', body: { through_date: '2026-07-31' } }), params({ accountKey: 'skattekonto' }))
    expect(missing.status).toBe(404)
  })

  it('POST reopen needs reconciliation:signoff, accepts an empty body, previews on dry run, 404s a bad id', async () => {
    authOk(['reconciliation:write'])
    const forbidden = await reopenPOST(req(`${BASE}/skattekonto/signoff/${SIGNOFF_ID}/reopen`, { method: 'POST' }), params({ accountKey: 'skattekonto', signoffId: SIGNOFF_ID }))
    expect(forbidden.status).toBe(403)

    authOk(['reconciliation:signoff'])
    const ok = await reopenPOST(req(`${BASE}/skattekonto/signoff/${SIGNOFF_ID}/reopen`, { method: 'POST' }), params({ accountKey: 'skattekonto', signoffId: SIGNOFF_ID }))
    expect(ok.status).toBe(200)
    expect(reopenMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', 'skattekonto', SIGNOFF_ID, { reason: null })

    const dry = await reopenPOST(req(`${BASE}/skattekonto/signoff/${SIGNOFF_ID}/reopen`, { method: 'POST', body: { reason: 'x' }, dryRun: true }), params({ accountKey: 'skattekonto', signoffId: SIGNOFF_ID }))
    expect(dry.status).toBe(200)
    expect(reopenMock).toHaveBeenCalledTimes(1)

    const bad = await reopenPOST(req(`${BASE}/skattekonto/signoff/nope/reopen`, { method: 'POST' }), params({ accountKey: 'skattekonto', signoffId: 'nope' }))
    expect(bad.status).toBe(404)

    reopenMock.mockRejectedValueOnce(new ReconciliationSignoffError('redan', 'ALREADY_REOPENED'))
    const already = await reopenPOST(req(`${BASE}/skattekonto/signoff/${SIGNOFF_ID}/reopen`, { method: 'POST' }), params({ accountKey: 'skattekonto', signoffId: SIGNOFF_ID }))
    expect(already.status).toBe(409)
  })
})
