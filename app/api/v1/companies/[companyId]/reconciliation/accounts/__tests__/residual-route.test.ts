/**
 * Tests for POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/residual:
 * real withApiV1 wrapper (auth, scope, membership, idempotency, dry-run), engine mocked.
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
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const { residualMock } = vi.hoisted(() => ({ residualMock: vi.fn() }))
vi.mock('@/lib/reconciliation/residual', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/residual')>('@/lib/reconciliation/residual')
  return { ...actual, bookResidualAndLink: residualMock }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ReconciliationResidualError } from '@/lib/reconciliation/residual'
import { POST } from '../[accountKey]/residual/route'

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
const KEY = `bank:${CASH}`
const T1 = '22222222-2222-4222-8222-222222222222'
const E1 = '44444444-4444-4444-8444-444444444444'
const URL = `http://localhost/api/v1/companies/${COMPANY_ID}/reconciliation/accounts/${KEY}/residual`
const body = { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }

function req(init: { body?: unknown; idem?: boolean; dryRun?: boolean } = {}): Request {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-fixture-not-a-real-key',
    'Content-Type': 'application/json',
  }
  if (init.idem !== false) headers['Idempotency-Key'] = `idem-${Math.random().toString(36).slice(2)}-aaaa-4abc-8def-1234567890ab`
  if (init.dryRun) headers['X-Dry-Run'] = 'true'
  return new Request(URL, { method: 'POST', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined })
}

function authOk(scopes: string[]) {
  mockValidate.mockResolvedValue({ valid: true, userId: 'user-1', keyId: 'key-1', keyName: 'Test key', scopes, mode: 'live' })
}

const params = (accountKey = KEY) => ({ params: Promise.resolve({ companyId: COMPANY_ID, accountKey }) }) as never

describe('v1 reconciliation residual', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: { data: { role: 'owner' } }, idempotency_keys: { data: null } }))
    residualMock.mockResolvedValue({ dry_run: false, residual_journal_entry_id: 'res-1', residual_amount: -10, applied: [{ external_id: T1, journal_entry_id: E1 }], skipped: [] })
  })

  it('401 without a valid key; 403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    expect((await POST(req({ body }), params())).status).toBe(401)
    authOk(['reconciliation:write'])
    expect((await POST(req({ body }), params())).status).toBe(403)
  })

  it('needs an Idempotency-Key, validates the body, 404s a bad key', async () => {
    authOk(['transactions:write'])
    expect((await POST(req({ body, idem: false }), params())).status).toBe(400)
    expect((await POST(req({ body: { external_ids: [T1] } }), params())).status).toBe(400)
    expect((await POST(req({ body }), params('1930'))).status).toBe(404)
    expect(residualMock).not.toHaveBeenCalled()
  })

  it('books and links, and previews on dry run', async () => {
    authOk(['transactions:write'])
    const res = await POST(req({ body }), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data.residual_journal_entry_id).toBe('res-1')
    expect(residualMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', KEY, body, { dryRun: false })

    residualMock.mockResolvedValue({ dry_run: true, would_book: { residual_amount: -10 } })
    const dry = await POST(req({ body, dryRun: true }), params())
    expect(dry.status).toBe(200)
    expect(residualMock).toHaveBeenLastCalledWith(expect.anything(), COMPANY_ID, 'user-1', KEY, body, { dryRun: true })
  })

  it('maps refusals to VALIDATION_ERROR with the residual code, and missing rows to NOT_FOUND', async () => {
    authOk(['transactions:write'])
    residualMock.mockRejectedValueOnce(new ReconciliationResidualError('fel riktning', 'RESIDUAL_DIRECTION'))
    const refused = await POST(req({ body }), params())
    expect(refused.status).toBe(400)
    const out = await refused.json()
    expect(out.error.code).toBe('VALIDATION_ERROR')
    expect(out.error.details.code).toBe('RESIDUAL_DIRECTION')

    residualMock.mockRejectedValueOnce(new ReconciliationResidualError('saknas', 'RESIDUAL_ENTRY_NOT_FOUND'))
    expect((await POST(req({ body }), params())).status).toBe(404)
  })
})
