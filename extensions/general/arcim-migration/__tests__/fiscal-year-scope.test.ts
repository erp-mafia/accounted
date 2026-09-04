import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Issue #2211: the direct provider connection fetches three fiscal years
 * (getAllowedFiscalYears in lib/sie-fetcher) and the wizard used to say
 * nothing about it. A first, broken year 2022/2023 simply never arrived and
 * the user asked whether they had done something wrong.
 *
 * The fetcher derives the left-out years from the year list it already
 * fetches; these tests lock that both routes the wizard reads carry them:
 * GET /preview (said before the import runs, with the window) and
 * GET /sie-data (the result step names them and points at the SIE path).
 */

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
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

vi.mock('../lib/sie-fetcher', () => ({
  providerSupportsSie: vi.fn().mockReturnValue(true),
  fetchProviderSieFiles: vi.fn(),
  getAllowedFiscalYears: vi.fn(),
}))

// The Fortnox asset preview would otherwise go to the network.
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
import { getConsent, resolveConsent, fetchCompanyInfoDirect } from '../lib/provider-client'
import { fetchProviderSieFiles, getAllowedFiscalYears } from '../lib/sie-fetcher'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

function handler(path: string): RouteHandler {
  return (arcimMigrationExtension.apiRoutes ?? []).find((r) => r.method === 'GET' && r.path === path)!
    .handler as RouteHandler
}

const CY = new Date().getFullYear()

// One fiscal year inside the window, enough SIE for the parser and the
// validator (#SIETYP + #RAR) so /sie-data reaches its response.
const SIE_IN_WINDOW = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Bolaget AB"',
  `#RAR 0 ${CY}0101 ${CY}1231`,
  '#KONTO 1930 "Företagskonto"',
  '',
].join('\n')

const OMITTED = [{ year: CY - 4, fromDate: `${CY - 4}-09-01`, toDate: `${CY - 3}-12-31` }]

function buildCtx(): ExtensionContext {
  const { supabase, mockResult } = createMockSupabase()
  // Every query in these routes reads lists or counts: none, everywhere.
  mockResult({ data: [], count: 0 })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
}

function request(path: string, consentId = 'consent-1') {
  return createMockRequest(`http://localhost/api/extensions/ext/arcim-migration${path}`, {
    searchParams: { consentId },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })
  ;(resolveConsent as Mock).mockResolvedValue({
    consent: { provider: 'fortnox' },
    accessToken: 'tok',
    providerCompanyId: undefined,
  })
  ;(fetchCompanyInfoDirect as Mock).mockResolvedValue(null)
  ;(getAllowedFiscalYears as Mock).mockReturnValue(new Set([CY - 2, CY - 1, CY]))
  ;(fetchProviderSieFiles as Mock).mockResolvedValue({
    files: [{ fiscalYear: CY, rawContent: SIE_IN_WINDOW }],
    availableYears: [CY],
    failedYears: [],
    omittedYears: OMITTED,
  })
})

describe('GET /preview: what the direct connection fetches (#2211)', () => {
  it('answers 401 without a user', async () => {
    const ctx = buildCtx()
    ;(ctx.supabase as unknown as { auth: { getUser: Mock } }).auth.getUser.mockResolvedValue({
      data: { user: null },
    })

    const res = await handler('/preview')(request('/preview'), ctx)

    expect(res.status).toBe(401)
  })

  it('carries the fetch window and the source years it leaves out', async () => {
    const res = await handler('/preview')(request('/preview'), buildCtx())
    const { status, body } = await parseJsonResponse<{
      sieAvailable: boolean
      sieStats: { fiscalYears: number[] }
      fiscalYearWindow: { fromYear: number; toYear: number }
      omittedYears: typeof OMITTED
    }>(res)

    expect(status).toBe(200)
    expect(body.sieAvailable).toBe(true)
    expect(body.sieStats.fiscalYears).toEqual([CY])
    expect(body.fiscalYearWindow).toEqual({ fromYear: CY - 2, toYear: CY })
    // The bounds as the provider reports them: a broken year is named as
    // "2022-09-01 till 2023-12-31", not as a wrong calendar year.
    expect(body.omittedYears).toEqual(OMITTED)
  })

  it('still names the omitted years when nothing inside the window came back', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [],
      availableYears: [],
      failedYears: [],
      omittedYears: OMITTED,
    })

    const res = await handler('/preview')(request('/preview'), buildCtx())
    const { status, body } = await parseJsonResponse<{ sieAvailable: boolean; omittedYears: typeof OMITTED }>(res)

    expect(status).toBe(200)
    expect(body.sieAvailable).toBe(false)
    expect(body.omittedYears).toEqual(OMITTED)
  })
})

describe('GET /sie-data: the omitted years reach the result step (#2211)', () => {
  it('answers 400 without a consentId', async () => {
    const res = await handler('/sie-data')(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data'),
      buildCtx(),
    )

    expect(res.status).toBe(400)
  })

  it('returns omittedYears next to failedYears', async () => {
    const res = await handler('/sie-data')(request('/sie-data'), buildCtx())
    const { status, body } = await parseJsonResponse<{
      fileStatuses: { fiscalYear: number }[]
      failedYears: unknown[]
      omittedYears: typeof OMITTED
    }>(res)

    expect(status).toBe(200)
    expect(body.fileStatuses.map((f) => f.fiscalYear)).toEqual([CY])
    expect(body.failedYears).toEqual([])
    expect(body.omittedYears).toEqual(OMITTED)
  })
})
