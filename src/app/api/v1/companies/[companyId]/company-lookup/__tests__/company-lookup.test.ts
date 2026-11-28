/**
 * POST /api/v1/companies/:companyId/company-lookup through the v1 door of
 * company-lookup.get (src/lib/operations/company-lookup.ts via
 * lib/operations/v1.ts).
 *
 * The register is the service an extension provides
 * (lib/company-lookup/registry-lookup.ts): core never imports the TIC
 * extension, so the test hands the extension registry a provider of its own.
 * Under test: the scope, the number's validation before anything is asked,
 * the charge (the MCP lookup's share, per user), the register's answer in the
 * door's shape, a miss, and no provider at all.
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
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const registry = vi.hoisted(() => ({ extensions: [] as Array<{ id: string; services?: Record<string, unknown> }> }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { getAll: async () => registry.extensions } }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { CompanyLookupResult, RegistryLookupOutcome } from '@/lib/company-lookup/types'
import { createTableMockSupabase } from '@/tests/helpers'
import { POST as lookupCompany } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/company-lookup`
const lookup = vi.fn<(orgNumber: string, charge: unknown) => Promise<RegistryLookupOutcome>>()

function found(overrides: Partial<CompanyLookupResult> = {}): CompanyLookupResult {
  return {
    companyName: 'Exempelbolaget AB',
    isCeased: false,
    address: { street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm' },
    registration: { fTax: true, vat: true },
    bankAccounts: [{ type: 'bankgiro', accountNumber: '5050-1055', bic: null }],
    email: 'info@example.com',
    phone: '08-123 45 67',
    sniCodes: [{ code: '62010', name: 'Dataprogrammering' }],
    fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
    legalEntityType: 'AB',
    registrationDate: Date.UTC(2018, 2, 1),
    ...overrides,
  }
}

function post(body: unknown) {
  return lookupCompany(
    new Request(URL_BASE, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Authorization: 'Bearer test-fixture-not-a-real-key', 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  registry.extensions = [{ id: 'tic', services: { lookupCompanyByOrgNumber: lookup } }]
  mockServiceClient.mockReturnValue(createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'member' } } }).supabase)
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Portal',
    scopes: ['companies:read'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/company-lookup', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await post({ org_number: '556677-8899' })).status).toBe(401)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('403 without companies:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    expect((await post({ org_number: '556677-8899' })).status).toBe(403)
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([{}, { org_number: '12345' }, { org_number: '556677-8898' }, { org_number: 5566778899 }])(
    '400 before the register is asked: %j',
    async (body) => {
      const res = await post(body)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
      expect(lookup).not.toHaveBeenCalled()
    },
  )

  it('answers the register\'s company, charged to the MCP lookup\'s share under the key, as MCP charges it', async () => {
    lookup.mockResolvedValue({ status: 'found', result: found() })
    const res = await post({ org_number: ' 556677-8899 ' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      status: 'found',
      company: {
        name: 'Exempelbolaget AB',
        org_number: '5566778899',
        legal_entity_type: 'AB',
        is_ceased: false,
        address: { street: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm' },
        f_skatt: true,
        vat_registered: true,
        fiscal_year: { start_month_day: '01-01', end_month_day: '12-31' },
        registration_date: '2018-03-01',
        sni_codes: [{ code: '62010', name: 'Dataprogrammering' }],
      },
      reason: null,
    })
    // The canonical number, and the budget and subject the MCP lookup spends (the key's id).
    expect(lookup).toHaveBeenCalledWith('5566778899', { purpose: 'mcp_lookup', subject: 'ak_1' })
  })

  it('a twelve-digit number with the century is the same number', async () => {
    lookup.mockResolvedValue({ status: 'not_found' })
    const res = await post({ org_number: '16556677-8899' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ status: 'not_found', company: null, reason: null })
    expect(lookup).toHaveBeenCalledWith('5566778899', expect.anything())
  })

  it('a ceased company with no address or closed year is answered as the register has it', async () => {
    lookup.mockResolvedValue({
      status: 'found',
      result: found({ isCeased: true, address: null, fiscalYear: null, registrationDate: null, legalEntityType: null }),
    })
    const { data } = await (await post({ org_number: '5566778899' })).json()
    expect(data.company).toMatchObject({ is_ceased: true, address: null, fiscal_year: null, registration_date: null, legal_entity_type: null })
  })

  it('passes the register\'s own failure on as unavailable with its reason', async () => {
    lookup.mockResolvedValue({ status: 'unavailable', reason: 'rate_limited' })
    const res = await post({ org_number: '5566778899' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ status: 'unavailable', company: null, reason: 'rate_limited' })
  })

  it('a reply the provider could not read is the register giving no answer, not a server error', async () => {
    lookup.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'names')"))
    const res = await post({ org_number: '5566778899' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ status: 'unavailable', company: null, reason: 'registry_error' })
  })

  it('without an extension that provides the register, answers unavailable: not_configured', async () => {
    registry.extensions = [{ id: 'other', services: {} }]
    const res = await post({ org_number: '5566778899' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ status: 'unavailable', company: null, reason: 'not_configured' })
  })
})
