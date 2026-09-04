import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Issues #2211 / #2238: the direct provider connection used to fetch three
 * fiscal years as a silent cap (getAllowedFiscalYears in lib/sie-fetcher).
 * A first, broken year 2022/2023 simply never arrived and the user asked
 * whether they had done something wrong. The cap is a default selection
 * now: the preview step renders every source year as a picker, /sie-data
 * fetches the ticked years, and the result step names the rest.
 *
 * These tests lock the plumbing the wizard reads: GET /preview carries
 * `sourceYears` (with the default flag), GET /sie-data honours `years` and
 * carries `omittedYears`.
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

const BROKEN_FIRST_YEAR = {
  year: CY - 4,
  fromDate: `${CY - 4}-09-01`,
  toDate: `${CY - 3}-12-31`,
  inDefaultSelection: false,
}
const CURRENT_YEAR = { year: CY, fromDate: `${CY}-01-01`, toDate: `${CY}-12-31`, inDefaultSelection: true }
const SOURCE_YEARS = [BROKEN_FIRST_YEAR, CURRENT_YEAR]
const OMITTED = [BROKEN_FIRST_YEAR]

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
    sourceYears: SOURCE_YEARS,
    failedYears: [],
    omittedYears: OMITTED,
  })
})

describe('GET /preview: every source year, with the default selection marked (#2211)', () => {
  it('answers 401 without a user', async () => {
    const ctx = buildCtx()
    ;(ctx.supabase as unknown as { auth: { getUser: Mock } }).auth.getUser.mockResolvedValue({
      data: { user: null },
    })

    const res = await handler('/preview')(request('/preview'), ctx)

    expect(res.status).toBe(401)
  })

  it('carries every source year with its bounds and default flag, on the default selection', async () => {
    const res = await handler('/preview')(request('/preview'), buildCtx())
    const { status, body } = await parseJsonResponse<{
      sieAvailable: boolean
      sieStats: { fiscalYears: number[] }
      sourceYears: typeof SOURCE_YEARS
    }>(res)

    expect(status).toBe(200)
    expect(body.sieAvailable).toBe(true)
    expect(body.sieStats.fiscalYears).toEqual([CY])
    // The bounds as the provider reports them: a broken year is named as
    // "2022-09-01 till 2023-12-31", not as a wrong calendar year, and it is
    // unticked by default rather than absent.
    expect(body.sourceYears).toEqual(SOURCE_YEARS)
    // The preview never sends a selection: its stats are the default's.
    expect((fetchProviderSieFiles as Mock).mock.calls[0][3]).toBeUndefined()
  })

  it('still lists the source years when nothing inside the default selection came back', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [],
      availableYears: [],
      sourceYears: [BROKEN_FIRST_YEAR],
      failedYears: [],
      omittedYears: [BROKEN_FIRST_YEAR],
    })

    const res = await handler('/preview')(request('/preview'), buildCtx())
    const { status, body } = await parseJsonResponse<{ sieAvailable: boolean; sourceYears: unknown[] }>(res)

    expect(status).toBe(200)
    expect(body.sieAvailable).toBe(false)
    expect(body.sourceYears).toEqual([BROKEN_FIRST_YEAR])
  })
})

describe('GET /sie-data: the ticked years are fetched, the rest are named (#2211, #2238)', () => {
  it('answers 400 without a consentId', async () => {
    const res = await handler('/sie-data')(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data'),
      buildCtx(),
    )

    expect(res.status).toBe(400)
  })

  it('answers 400 VALIDATION_ERROR on a malformed years selection, before touching the provider', async () => {
    const res = await handler('/sie-data')(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data', {
        searchParams: { consentId: 'consent-1', years: `${CY},abc` },
      }),
      buildCtx(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(fetchProviderSieFiles).not.toHaveBeenCalled()
  })

  it('falls back to the default selection without a years param and returns omittedYears', async () => {
    const res = await handler('/sie-data')(request('/sie-data'), buildCtx())
    const { status, body } = await parseJsonResponse<{
      fileStatuses: { fiscalYear: number }[]
      failedYears: unknown[]
      omittedYears: typeof OMITTED
    }>(res)

    expect(status).toBe(200)
    expect((fetchProviderSieFiles as Mock).mock.calls[0][3]).toBeUndefined()
    expect(body.fileStatuses.map((f) => f.fiscalYear)).toEqual([CY])
    expect(body.failedYears).toEqual([])
    expect(body.omittedYears).toEqual(OMITTED)
  })

  it('passes the ticked years to the fetcher, deduplicated and oldest first', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [
        { fiscalYear: CY - 4, rawContent: SIE_IN_WINDOW.replace(`#RAR 0 ${CY}0101 ${CY}1231`, `#RAR 0 ${CY - 4}0901 ${CY - 3}1231`) },
        { fiscalYear: CY, rawContent: SIE_IN_WINDOW },
      ],
      availableYears: [CY - 4, CY],
      sourceYears: SOURCE_YEARS,
      failedYears: [],
      omittedYears: [],
    })

    const res = await handler('/sie-data')(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data', {
        searchParams: { consentId: 'consent-1', years: `${CY},${CY - 4},${CY}` },
      }),
      buildCtx(),
    )
    const { status, body } = await parseJsonResponse<{
      fileStatuses: { fiscalYear: number }[]
      omittedYears: unknown[]
    }>(res)

    expect(status).toBe(200)
    expect((fetchProviderSieFiles as Mock).mock.calls[0][3]).toEqual({ years: [CY - 4, CY] })
    expect(body.fileStatuses.map((f) => f.fiscalYear)).toEqual([CY - 4, CY])
    expect(body.omittedYears).toEqual([])
  })

  it('names the selection in PROVIDER_SIE_NO_YEARS when none of the ticked years exist at the source', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [],
      availableYears: [],
      sourceYears: SOURCE_YEARS,
      failedYears: [],
      omittedYears: SOURCE_YEARS,
    })

    const res = await handler('/sie-data')(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data', {
        searchParams: { consentId: 'consent-1', years: `${CY - 7}` },
      }),
      buildCtx(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)

    expect(status).toBe(404)
    expect(body.error.code).toBe('PROVIDER_SIE_NO_YEARS')
    expect(body.error.message).toContain(String(CY - 7))
  })
})
