import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { FortnoxApiError } from '@/lib/providers/fortnox/client'
import { BrioxApiError } from '@/lib/providers/briox/client'

/**
 * crm#1118 follow-up: GET /preview caught every SIE fetch failure, logged it
 * and answered sieAvailable: false, the same answer Visma and Bokio get
 * because they serve no SIE over the API. The wizard then told a Fortnox
 * customer "SIE-import krävs" when the connection had expired, was rate
 * limited or lacked a permission. The preview now carries `sieError` in the
 * classification /sie-data answers with: classifyProviderError runs for real
 * here, only the provider calls are stubbed.
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
  fetchAccountingAccountsDirect: vi.fn().mockResolvedValue([]),
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

// The real provider gate and classification; only the provider calls are stubbed.
vi.mock('../lib/sie-fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sie-fetcher')>()),
  fetchProviderSieFiles: vi.fn(),
}))

// The Fortnox asset preview would otherwise go to the network.
vi.mock('../lib/import-assets', () => ({
  fetchFortnoxAssetPreview: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { getConsent, resolveConsent, fetchCompanyInfoDirect } from '../lib/provider-client'
import { fetchProviderSieFiles } from '../lib/sie-fetcher'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

const previewHandler = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'GET' && r.path === '/preview',
)!.handler as RouteHandler

interface PreviewBody {
  sieAvailable: boolean
  sieError: { code: string; reason?: string } | null
  companyInfo: { company_name: string | null } | null
}

const CY = new Date().getFullYear()
const CURRENT_YEAR = { year: CY, fromDate: `${CY}-01-01`, toDate: `${CY}-12-31`, inDefaultSelection: true }
const SIE = ['#FLAGGA 0', '#SIETYP 4', `#RAR 0 ${CY}0101 ${CY}1231`, '#KONTO 1930 "Företagskonto"', ''].join('\n')

function fortnoxError(status: number, code?: number, message = 'Fortnox svarar nej'): FortnoxApiError {
  const body = code === undefined ? '' : JSON.stringify({ ErrorInformation: { error: 1, message, code } })
  return new FortnoxApiError(`Fortnox API error: ${status}`, status, body)
}

function connect(provider: 'fortnox' | 'briox' | 'visma') {
  ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider })
  ;(resolveConsent as Mock).mockResolvedValue({
    consent: { provider },
    accessToken: 'tok',
    providerCompanyId: undefined,
  })
}

async function preview() {
  const { supabase, mockResult } = createMockSupabase()
  // The handler counts completed SIE imports at the end: none.
  mockResult({ count: 0 })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = { supabase, companyId: 'company-1', log } as unknown as ExtensionContext
  const request = createMockRequest('http://localhost/api/extensions/ext/arcim-migration/preview', {
    searchParams: { consentId: 'consent-1' },
  })
  return { ...(await parseJsonResponse<PreviewBody>(await previewHandler(request, ctx))), log }
}

/** The line that names the class of a failed SIE fetch in the logs, whichever path failed. */
function loggedClass(log: { info: Mock }): string | undefined {
  const call = log.info.mock.calls.find(([message]) => String(message).startsWith('SIE export failed ('))
  return call ? /^SIE export failed \((\w+)\):/.exec(String(call[0]))?.[1] : undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  connect('fortnox')
  ;(fetchCompanyInfoDirect as Mock).mockResolvedValue(null)
})

describe('GET /preview: a failed SIE fetch says why (crm#1118)', () => {
  it.each([
    ['an expired connection', fortnoxError(401), { code: 'PROVIDER_AUTH_EXPIRED' }],
    [
      'a permission the connecting user lacks',
      fortnoxError(403, 2000663, 'Har inte behörighet för scope.'),
      { code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'permission' },
    ],
    [
      'a module the plan lacks',
      fortnoxError(400, 2001101, 'Det finns ingen aktiv licens för önskat scope.'),
      { code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'license' },
    ],
    ['a missing integration licence', fortnoxError(400, 2001103, 'Api-licens saknas.'), { code: 'PROVIDER_LICENSE_MISSING' }],
    ['a rate limit', fortnoxError(429), { code: 'PROVIDER_RATE_LIMITED' }],
    ['an outage', fortnoxError(503), { code: 'PROVIDER_UPSTREAM_ERROR' }],
    ['an unreachable provider', new TypeError('fetch failed'), { code: 'PROVIDER_UNREACHABLE' }],
    // classifyProviderError has no class for a timeout: it lands where
    // /sie-data's fallback does, which the wizard reads as "try again".
    [
      'a timeout',
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      { code: 'PROVIDER_SIE_FETCH_FAILED' },
    ],
  ])('names %s in sieError and still answers the preview', async (_cause, error, expected) => {
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Bolaget AB' })
    ;(fetchProviderSieFiles as Mock).mockRejectedValue(error)

    const { status, body, log } = await preview()

    expect(status).toBe(200)
    expect(body.sieAvailable).toBe(false)
    expect(body.sieError).toEqual(expected)
    // Soft: the rest of the preview is still there.
    expect(body.companyInfo?.company_name).toBe('Bolaget AB')
    expect(loggedClass(log)).toBe(expected.code)
  })

  it('reads a 403 on the year list as a refused ledger once the company card came back on the same token', async () => {
    connect('briox')
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Bolaget AB' })
    ;(fetchProviderSieFiles as Mock).mockRejectedValue(new BrioxApiError('Briox API error: 403', 403))

    const { body } = await preview()

    // Reconnecting would mint the same grant and meet the same 403.
    expect(body.sieError).toEqual({ code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'permission' })
  })

  it('reads the same 403 as an expired connection when nothing has answered on the token yet', async () => {
    connect('briox')
    ;(fetchProviderSieFiles as Mock).mockRejectedValue(new BrioxApiError('Briox API error: 403', 403))

    const { body } = await preview()

    expect(body.sieError).toEqual({ code: 'PROVIDER_AUTH_EXPIRED' })
  })

  it('names why when the year list came back but every export failed', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [],
      sourceYears: [CURRENT_YEAR],
      failedYears: [
        { year: CY, error: 'Fortnox API error: 403', code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'permission' },
      ],
      omittedYears: [],
    })

    const { status, body } = await preview()

    expect(status).toBe(200)
    expect(body.sieAvailable).toBe(false)
    expect(body.sieError).toEqual({ code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'permission' })
  })

  it('logs the class when every export failed, as it does for a failed year list', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [],
      sourceYears: [{ ...CURRENT_YEAR, year: CY - 1 }, CURRENT_YEAR],
      failedYears: [
        { year: CY - 1, error: 'Fortnox API error: 503', code: 'PROVIDER_UPSTREAM_ERROR' },
        { year: CY, error: 'Fortnox API error: 503', code: 'PROVIDER_UPSTREAM_ERROR' },
      ],
      omittedYears: [],
    })

    const { body, log } = await preview()

    expect(body.sieError).toEqual({ code: 'PROVIDER_UPSTREAM_ERROR' })
    expect(loggedClass(log)).toBe('PROVIDER_UPSTREAM_ERROR')
    // Every failed year is named, not only the one the answer reads.
    expect(log.info).toHaveBeenCalledWith(
      'SIE export failed (PROVIDER_UPSTREAM_ERROR):',
      `${CY - 1}: Fortnox API error: 503; ${CY}: Fortnox API error: 503`,
    )
  })
})

describe('GET /preview: no sieError without a failure', () => {
  it('is null when the export came back', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [{ fiscalYear: CY, rawContent: SIE }],
      sourceYears: [CURRENT_YEAR],
      failedYears: [],
      omittedYears: [],
    })

    const { body, log } = await preview()

    expect(body.sieAvailable).toBe(true)
    expect(body.sieError).toBeNull()
    expect(loggedClass(log)).toBeUndefined()
  })

  it('is null for Visma, which serves no SIE over the API: the SIE upload stays the way', async () => {
    connect('visma')

    const { body } = await preview()

    expect(body.sieAvailable).toBe(false)
    expect(body.sieError).toBeNull()
    expect(fetchProviderSieFiles).not.toHaveBeenCalled()
  })

  it('is null when no year of the default selection exists at the source', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [],
      sourceYears: [],
      failedYears: [],
      omittedYears: [],
    })

    const { body } = await preview()

    expect(body.sieAvailable).toBe(false)
    expect(body.sieError).toBeNull()
  })
})
