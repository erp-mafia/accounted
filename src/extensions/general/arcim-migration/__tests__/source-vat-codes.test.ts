/**
 * Issue #2585: a Fortnox user saw the mapping step propose momskoder that
 * differed from the ones on their own kontoplan. The SIE export the guided
 * import runs on carries no VAT codes, so /sie-data now also fetches the
 * provider's chart and prefills each identity mapping with the translated
 * code. Pinned here:
 *   - a translated code arrives on the mapping as a reviewed provider
 *     treatment, with the verbatim code kept for the UI;
 *   - a code without a translation keeps only the verbatim code;
 *   - a failed chart fetch never fails the step: the SIE data still comes
 *     back and the rows fall back to the label suggestion.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn(),
}))

vi.mock('../lib/provider-client', () => ({
  createConsent: vi.fn(),
  getConsent: vi.fn(),
  listConsents: vi.fn(),
  generateOtc: vi.fn(),
  consumeOAuthState: vi.fn(),
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn(),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
  fetchAccountingAccountsDirect: vi.fn(),
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

vi.mock('../lib/sie-fetcher', () => ({
  providerSupportsSie: vi.fn().mockReturnValue(true),
  fetchProviderSieFiles: vi.fn(),
  getAllowedFiscalYears: vi.fn(),
  FiscalYearSelectionError: class FiscalYearSelectionError extends Error {
    constructor(public readonly unknownYears: number[]) {
      super(`unknown ${unknownYears.join(', ')}`)
    }
  },
  MAX_SELECTED_FISCAL_YEARS: 6,
}))

vi.mock('../lib/import-assets', () => ({
  fetchFortnoxAssetPreview: vi.fn().mockResolvedValue(null),
}))

vi.mock('../lib/mapping-targets', () => ({
  buildMappingTargets: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { resolveConsent, fetchAccountingAccountsDirect } from '../lib/provider-client'
import { fetchProviderSieFiles, getAllowedFiscalYears } from '../lib/sie-fetcher'
import type { AccountMapping } from '@/lib/import/types'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

const sieData = (arcimMigrationExtension.apiRoutes ?? [])
  .find((r) => r.method === 'GET' && r.path === '/sie-data')!.handler as RouteHandler

const CY = new Date().getFullYear()

// A chart with a revenue account, a purchase account, a moms account and a
// bank account: the four cases the prefill has to tell apart.
const SIE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Bolaget AB"',
  `#RAR 0 ${CY}0101 ${CY}1231`,
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2611 "Utgående moms 25%"',
  '#KONTO 3041 "Försäljn tjänst sv"',
  '#KONTO 4056 "Inköp varor EU"',
  '#KONTO 3001 "Uttag"',
  '',
].join('\n')

function buildCtx(): ExtensionContext {
  const { supabase, mockResult } = createMockSupabase()
  mockResult({ data: [], count: 0 })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
}

function request() {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data', {
    searchParams: { consentId: 'consent-1' },
  })
}

async function mappingsFrom(res: Response): Promise<Map<string, AccountMapping>> {
  const { status, body } = await parseJsonResponse<{ mappings: AccountMapping[] }>(res)
  expect(status).toBe(200)
  return new Map(body.mappings.map((m) => [m.sourceAccount, m]))
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(resolveConsent as Mock).mockResolvedValue({
    consent: { provider: 'fortnox' },
    accessToken: 'tok',
    providerCompanyId: undefined,
  })
  ;(getAllowedFiscalYears as Mock).mockReturnValue(new Set([CY - 2, CY - 1, CY]))
  ;(fetchProviderSieFiles as Mock).mockResolvedValue({
    files: [{ fiscalYear: CY, rawContent: SIE }],
    availableYears: [CY],
    sourceYears: [{ year: CY, fromDate: `${CY}-01-01`, toDate: `${CY}-12-31`, inDefaultSelection: true }],
    failedYears: [],
    omittedYears: [],
  })
})

describe('GET /sie-data: momskod from the source system (#2585)', () => {
  it('prefills identity mappings from the Fortnox chart and keeps the verbatim code', async () => {
    ;(fetchAccountingAccountsDirect as Mock).mockResolvedValue([
      { accountNumber: '1930', name: 'Företagskonto', active: true },
      { accountNumber: '2611', name: 'Utgående moms 25%', vatCode: 'U1', active: true },
      { accountNumber: '3041', name: 'Försäljn tjänst sv', vatCode: 'MP1', active: true },
      { accountNumber: '4056', name: 'Inköp varor EU', vatCode: 'IVEU', active: true },
      { accountNumber: '3001', name: 'Uttag', vatCode: 'UT', active: true },
    ])

    const mappings = await mappingsFrom(await sieData(request(), buildCtx()))

    expect(fetchAccountingAccountsDirect).toHaveBeenCalledWith('fortnox', 'tok')
    // A suggestion, not a reviewed value: the row still needs its confirm.
    expect(mappings.get('3041')).toMatchObject({
      providerVatCode: 'MP1',
      providerVatTreatment: 'standard_25',
      defaultVatTreatment: 'standard_25',
      defaultVatRate: 0.25,
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
    expect(mappings.get('4056')).toMatchObject({
      providerVatCode: 'IVEU',
      providerVatTreatment: 'reverse_charge_eu_goods',
      defaultVatTreatment: 'reverse_charge_eu_goods',
      defaultVatRate: 0.25,
      vatTreatmentReviewed: false,
    })
    // No treatment exists for uttag (ruta 06): the code is shown, the row
    // is left to the label suggestion.
    expect(mappings.get('3001')).toMatchObject({ providerVatCode: 'UT', providerVatTreatment: null })
    expect(mappings.get('3001')?.defaultVatTreatment).toBeUndefined()
    // Moms and bank accounts carry no treatment, whatever Fortnox says.
    expect(mappings.get('2611')?.providerVatCode).toBeUndefined()
    expect(mappings.get('1930')?.providerVatCode).toBeUndefined()
  })

  it('answers the SIE data without codes when the chart fetch fails', async () => {
    ;(fetchAccountingAccountsDirect as Mock).mockRejectedValue(new Error('Fortnox API error: 503'))

    const mappings = await mappingsFrom(await sieData(request(), buildCtx()))

    expect(mappings.size).toBe(5)
    for (const mapping of mappings.values()) {
      expect(mapping.providerVatCode).toBeUndefined()
      expect(mapping.providerVatTreatment).toBeUndefined()
    }
  })

  it('changes nothing for a provider that reports no codes', async () => {
    ;(fetchAccountingAccountsDirect as Mock).mockResolvedValue([])

    const mappings = await mappingsFrom(await sieData(request(), buildCtx()))

    expect(mappings.get('3041')?.providerVatCode).toBeUndefined()
    expect(mappings.get('3041')?.defaultVatTreatment).toBeUndefined()
  })
})
