/**
 * Bankgiro Lookup through the v1 door of the operation registry
 * (src/lib/operations/bankgiro-lookup.ts):
 *   GET /api/v1/companies/:companyId/payments/creditor-lookup
 *   GET /api/v1/companies/:companyId/payments/giro-numbers
 *
 * Auth, scope and envelope are withApiV1's; the service is mocked (its own
 * tests cover the flag, the cache and Connect).
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
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/payments/bankgiro-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/bankgiro-lookup')>()),
  lookupCreditorName: vi.fn(),
  lookupCompanyGiroNumbers: vi.fn(),
}))

import { createTableMockSupabase } from '@/tests/helpers'
import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { lookupCompanyGiroNumbers, lookupCreditorName } from '@/lib/payments/bankgiro-lookup'
import { GET as creditorLookup } from '../creditor-lookup/route'
import { GET as giroNumbers } from '../giro-numbers/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const creditor = vi.mocked(lookupCreditorName)
const giros = vi.mocked(lookupCompanyGiroNumbers)

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/payments`
const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

/** The door reads the caller's membership; the service (mocked) reads nothing here. */
function client(role = 'member') {
  const { supabase } = createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role } } })
  mockServiceClient.mockReturnValue(supabase)
  return supabase
}

function request(url: string): Request {
  return new Request(url, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  client()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['suppliers:read', 'companies:read'],
    mode: 'live',
  })
})

describe('GET /payments/creditor-lookup', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await creditorLookup(request(`${BASE}/creditor-lookup?giro=5050-1055&type=bankgiro`), companyParams)).status).toBe(401)
    expect(creditor).not.toHaveBeenCalled()
  })

  it('403 without suppliers:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['companies:read'], mode: 'live' })
    client('owner')
    expect((await creditorLookup(request(`${BASE}/creditor-lookup?giro=5050-1055&type=bankgiro`), companyParams)).status).toBe(403)
  })

  it('400 VALIDATION_ERROR without a giro type, or with an unknown one', async () => {
    for (const query of ['giro=5050-1055', 'giro=5050-1055&type=iban', 'type=bankgiro']) {
      const res = await creditorLookup(request(`${BASE}/creditor-lookup?${query}`), companyParams)
      expect(res.status, query).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
    expect(creditor).not.toHaveBeenCalled()
  })

  it('answers the registered name and the OCR verdict', async () => {
    creditor.mockResolvedValue({ enabled: true, available: true, creditorName: 'Derome Bygg AB', ocrValid: true, warnings: [] })
    const res = await creditorLookup(request(`${BASE}/creditor-lookup?giro=5050-1055&type=bankgiro&ocr=4400112233`), companyParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ enabled: true, available: true, reason: null, creditor_name: 'Derome Bygg AB', ocr_valid: true, warnings: [] })
    expect(creditor).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }), { giro: '5050-1055', type: 'bankgiro', ocr: '4400112233', invoiceRef: null })
  })

  it('answers not_found as data, not as a 404', async () => {
    creditor.mockResolvedValue({ enabled: true, available: false, reason: 'not_found' })
    const res = await creditorLookup(request(`${BASE}/creditor-lookup?giro=5050-1055&type=bankgiro`), companyParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ available: false, reason: 'not_found' })
  })
})

describe('GET /payments/giro-numbers', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await giroNumbers(request(`${BASE}/giro-numbers`), companyParams)).status).toBe(401)
  })

  it('403 without companies:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    client('owner')
    expect((await giroNumbers(request(`${BASE}/giro-numbers`), companyParams)).status).toBe(403)
    expect(giros).not.toHaveBeenCalled()
  })

  it('answers the company\'s registered giro numbers', async () => {
    giros.mockResolvedValue({ enabled: true, available: true, giroNumbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }] })
    const res = await giroNumbers(request(`${BASE}/giro-numbers`), companyParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ enabled: true, available: true, reason: null, giro_numbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }] })
  })
})
