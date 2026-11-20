/**
 * v1 GET /reports/ar-ledger and /reports/supplier-ledger: the as_of_date
 * check is the shared parseLedgerAsOfDate (lib/reports/ledger-as-of.ts) the
 * MCP tools run too; the answers are the ones these routes always gave.
 * There is no resource id on these routes, so no 404 case.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// The shared wrapper's lease boundary has separate real and unit coverage.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

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

const mocks = vi.hoisted(() => ({ generateARLedger: vi.fn(), generateSupplierLedger: vi.fn() }))
vi.mock('@/lib/reports/ar-ledger', () => ({ generateARLedger: mocks.generateARLedger }))
vi.mock('@/lib/reports/supplier-ledger', () => ({ generateSupplierLedger: mocks.generateSupplierLedger }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as arLedger } from '../ar-ledger/route'
import { GET as supplierLedger } from '../supplier-ledger/route'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeReq(path: string, query = ''): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/reports/${path}${query}`, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1', companyId: COMPANY_ID, apiKeyId: 'ak_1', apiKeyName: 'CI key',
    scopes: ['reports:read'], mode: 'live',
  })
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    }).supabase,
  )
  mocks.generateARLedger.mockResolvedValue({ as_of_date: '2026-09-30', customers: [], totals: {} })
  mocks.generateSupplierLedger.mockResolvedValue({ as_of_date: '2026-09-30', suppliers: [], totals: {} })
})

describe.each([
  ['ar-ledger', arLedger, mocks.generateARLedger],
  ['supplier-ledger', supplierLedger, mocks.generateSupplierLedger],
] as const)('GET /reports/%s', (path, handler, generator) => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await handler(makeReq(path), params)
    expect(res.status).toBe(401)
    expect(generator).not.toHaveBeenCalled()
  })

  it.each([
    ['?as_of_date=garbage', 'Expected YYYY-MM-DD.'],
    ['?as_of_date=2025-02-30', 'Not a valid calendar date.'],
    ['?as_of_date=1999-12-31', /^Year out of supported range\. Accepted: 2000 to \d{4}\.$/],
  ])('400 VALIDATION_ERROR for %s, before the generator runs', async (query, message) => {
    const res = await handler(makeReq(path, query), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('as_of_date')
    expect(body.error.details.message).toEqual(typeof message === 'string' ? message : expect.stringMatching(message))
    expect(generator).not.toHaveBeenCalled()
  })

  it('200 with the generator answer for a real date', async () => {
    const res = await handler(makeReq(path, '?as_of_date=2026-09-30'), params)
    expect(res.status).toBe(200)
    expect(generator).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, '2026-09-30')
  })

  it('defaults to today when as_of_date is absent or empty', async () => {
    await handler(makeReq(path, '?as_of_date='), params)
    await handler(makeReq(path), params)
    expect(generator).toHaveBeenNthCalledWith(1, expect.anything(), COMPANY_ID, undefined)
    expect(generator).toHaveBeenNthCalledWith(2, expect.anything(), COMPANY_ID, undefined)
  })
})
