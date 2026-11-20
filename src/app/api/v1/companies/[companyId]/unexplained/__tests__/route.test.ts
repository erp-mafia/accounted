/**
 * GET /unexplained, /unexplained/{checkId} and /unexplained/{checkId}/explain
 * through the v1 door of the operation registry
 * (src/lib/operations/unexplained.ts). The service client is the in-memory
 * company of the check tests, so the routes run the real checks and report
 * generators end to end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// The SIE import lease has its own tests (lib/import/__tests__/sie-period-read.test.ts).
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
  // The fixture's räkenskapsår is 2026: the checks read "today".
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'))
})
afterAll(() => {
  vi.useRealTimers()
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { toHandle } from '@/lib/handles'
import { createFakeLedger } from '@/lib/measures/__tests__/fake-ledger'
import { CA_1930, CO, checkFixture } from '@/lib/unexplained/__tests__/fixtures'
import { GET as listUnexplained } from '../route'
import { GET as getCheck } from '../[checkId]/route'
import { GET as explainCheck } from '../[checkId]/explain/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const BASE = `https://x.test/api/v1/companies/${CO}/unexplained`
type Handler = (req: Request, p: { params: Promise<Record<string, string>> }) => Promise<Response>

function call(handler: Handler, path: string, params: Record<string, string> = {}) {
  return handler(new Request(`${BASE}${path}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }), {
    params: Promise.resolve({ companyId: CO, ...params }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: CO,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  const data = checkFixture()
  data.extraTables = { ...data.extraTables, company_members: [{ company_id: CO, user_id: 'user-1', role: 'owner' }] }
  mockServiceClient.mockReturnValue(createFakeLedger(data).supabase)
})

describe('auth and scope', () => {
  const doors: Array<[string, Handler, string, Record<string, string>]> = [
    ['list', listUnexplained as Handler, '', {}],
    ['get', getCheck as Handler, '/receivables_vs_ledger', { checkId: 'receivables_vs_ledger' }],
    ['explain', explainCheck as Handler, '/receivables_vs_ledger/explain', { checkId: 'receivables_vs_ledger' }],
  ]

  it.each(doors)('%s: 401 when the API key is rejected', async (_name, handler, path, params) => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await call(handler, path, params)).status).toBe(401)
  })

  it.each(doors)('%s: 403 without reports:read', async (_name, handler, path, params) => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: CO, scopes: ['transactions:read'], mode: 'live' })
    expect((await call(handler, path, params)).status).toBe(403)
  })
})

describe('GET /unexplained', () => {
  it('lists the queue: unexplained first, every row with its explain path', async () => {
    const res = await call(listUnexplained as Handler, '')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.counts).toEqual({ unexplained: 2, cannot_check: 2, ok: 4 })
    expect(body.data.items[0]).toMatchObject({ check_id: 'receivables_vs_ledger', status: 'unexplained', difference: 3000, unit: 'SEK' })
    expect(body.data.items[0].explain.v1_path).toBe(`/api/v1/companies/${CO}/unexplained/receivables_vs_ledger/explain`)
  })

  it('400 for a query parameter the endpoint does not know, never dropped', async () => {
    const res = await call(listUnexplained as Handler, '?status=unexplained')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })
})

describe('GET /unexplained/{checkId}', () => {
  it('200 with the definition, basis and both figures', async () => {
    const res = await call(getCheck as Handler, '/payables_vs_ledger', { checkId: 'payables_vs_ledger' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ check_id: 'payables_vs_ledger', status: 'ok', unit: 'SEK', subject_kind: 'company' })
    expect(body.data.results[0].sides.map((s: { amount: number }) => s.amount)).toEqual([10000, 10000])
    expect(body.data.id).toBeUndefined()
  })

  it('404 UNEXPLAINED_CHECK_NOT_FOUND with the valid ids', async () => {
    const res = await call(getCheck as Handler, '/bank', { checkId: 'bank' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('UNEXPLAINED_CHECK_NOT_FOUND')
    expect(body.error.details.valid).toContain('bank_balance_vs_bank')
  })
})

describe('GET /unexplained/{checkId}/explain', () => {
  it('200 with the parts and the items behind them, paged', async () => {
    const res = await call(explainCheck as Handler, '/receivables_vs_ledger/explain?limit=1', { checkId: 'receivables_vs_ledger' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ difference: 3000, residual: 0, reconciles: true })
    expect(body.data.items).toMatchObject({ total: 1, offset: 0, next_offset: null })
    expect(body.data.items.list[0].handle).toMatch(/^inv_[0-9a-f]{32}$/)
  })

  it('takes the bank account as a cash_ handle', async () => {
    const res = await call(explainCheck as Handler, `/bank_balance_vs_bank/explain?cash_account_id=${toHandle('cash_account', CA_1930)}`, {
      checkId: 'bank_balance_vs_bank',
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: 'ok', subject: { kind: 'bank_account', cash_account_id: CA_1930 } })
  })

  it('400 UNEXPLAINED_SUBJECT_REQUIRED for a check with several results and no subject', async () => {
    const res = await call(explainCheck as Handler, '/bank_balance_vs_bank/explain', { checkId: 'bank_balance_vs_bank' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('UNEXPLAINED_SUBJECT_REQUIRED')
    expect(body.error.details.subjects).toHaveLength(2)
  })

  it('400 UNEXPLAINED_PARAMETER_NOT_ACCEPTED for a subject a company-wide check does not take', async () => {
    const res = await call(explainCheck as Handler, `/payables_vs_ledger/explain?cash_account_id=${CA_1930}`, { checkId: 'payables_vs_ledger' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('UNEXPLAINED_PARAMETER_NOT_ACCEPTED')
  })

  it('404 UNEXPLAINED_SUBJECT_NOT_FOUND for a momsperiod without a result', async () => {
    const res = await call(explainCheck as Handler, '/vat_declared_not_settled/explain?period_type=quarterly&year=2026&period=3', {
      checkId: 'vat_declared_not_settled',
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('UNEXPLAINED_SUBJECT_NOT_FOUND')
  })

  it('400 VALIDATION_ERROR for a malformed cash_account_id', async () => {
    const res = await call(explainCheck as Handler, '/bank_balance_vs_bank/explain?cash_account_id=nope', { checkId: 'bank_balance_vs_bank' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })
})
