/**
 * #3312: the onboarding provider step fetched FY2026 from Fortnox and the job
 * refused it every time with SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS. FY2026
 * carries amounts on class 9 (hour statistics, an OBS posting); FY2025, which
 * went through, carried the same accounts unused.
 *
 * The step's whole chain, as it runs in the browser: GET /sie-data, the
 * step's own completion of blank targets (resolveOnboardingMappings), then
 * POST /import-sie with the path /sie-data archived the year under, whose
 * job admission runs the real validator. Each way a
 * 9xxx target used to reach the job is covered: a stored mapping from the
 * earlier year's import, the company chart's own 9xxx row, and a blank
 * target the step mapped onto itself.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('../lib/migration-orchestrator', () => ({ executeMigration: vi.fn() }))

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
  FiscalYearSelectionError: class FiscalYearSelectionError extends Error {},
  MAX_SELECTED_FISCAL_YEARS: 6,
}))

vi.mock('../lib/import-assets', () => ({ fetchFortnoxAssetPreview: vi.fn().mockResolvedValue(null) }))
vi.mock('../lib/mapping-targets', () => ({ buildMappingTargets: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/import/sie-jobs', async (load) => ({
  ...await load<typeof import('@/lib/import/sie-jobs')>(),
  submitSIEJob: vi.fn(),
}))
vi.mock('next/server', async (load) => ({ ...await load<typeof import('next/server')>(), after: vi.fn() }))
vi.mock('@/lib/import/sie-job-worker', () => ({ runSIEWorker: vi.fn() }))

import { arcimMigrationExtension } from '../index'
import { resolveConsent, fetchAccountingAccountsDirect } from '../lib/provider-client'
import { fetchProviderSieFiles, getAllowedFiscalYears } from '../lib/sie-fetcher'
import { buildMappingTargets } from '../lib/mapping-targets'
import { submitSIEJob } from '@/lib/import/sie-jobs'
import { resolveOnboardingMappings } from '@/lib/onboarding-books/mappings'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import type { AccountMapping, SIEAccount } from '@/lib/import/types'
import { memoryIntakeStorage } from './intake-storage'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const route = (method: string, path: string) =>
  (arcimMigrationExtension.apiRoutes ?? []).find((r) => r.method === method && r.path === path)!.handler as RouteHandler
const sieData = route('GET', '/sie-data')
const importSie = route('POST', '/import-sie')

const CHART = [
  '#KONTO 1930 "Företagskonto"', '#KONTO 2099 "Årets resultat"', '#KONTO 3001 "Försäljning tjänster"',
  '#KONTO 9000 "Debiterbar tid"', '#KONTO 9010 "Motkonto tid"', '#KONTO 9999 "OBS-konto"',
]
const FY2025 = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Konsultbolaget AB"', '#RAR 0 20250101 20251231', ...CHART,
  '#VER A 1 20250115 "Faktura 1"', '{', '#TRANS 1930 {} 1000.00', '#TRANS 3001 {} -1000.00', '}',
].join('\n')
const FY2026 = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Konsultbolaget AB"',
  '#RAR 0 20260101 20261231', '#RAR -1 20250101 20251231', ...CHART,
  '#IB 0 1930 1000.00', '#IB 0 2099 -1000.00',
  '#VER A 1 20260110 "Tidrapport vecka 2"', '{', '#TRANS 9000 {} 4000.00', '#TRANS 9010 {} -4000.00', '}',
  '#VER A 2 20260131 "Faktura 2"', '{', '#TRANS 1930 {} 2500.00', '#TRANS 3001 {} -2500.00',
  '#TRANS 9000 {} 1200.00', '#TRANS 9010 {} -1200.00', '}',
  '#VER A 3 20260215 "Okänd inbetalning"', '{', '#TRANS 1930 {} 500.00', '#TRANS 9999 {} -500.00', '}',
  '#RES 0 3001 -2500.00', '#RES 0 9000 5200.00', '#RES 0 9010 -5200.00',
].join('\n')
const CLASS_9 = ['9000', '9010', '9999']

const STORED_SELF_MAPS = CLASS_9.map((number) => ({
  source_account: number, source_name: '', target_account: number, confidence: 1, match_type: 'exact',
}))
const CHART_ROWS = [
  { account_number: '9000', account_name: 'Debiterbar tid', account_class: 9 },
  { account_number: '9010', account_name: 'Motkonto tid', account_class: 9 },
  { account_number: '9999', account_name: 'OBS-konto', account_class: 9 },
]

/** Answers by table: the stored mappings for sie_account_mappings, nothing elsewhere. */
function buildCtx(stored: unknown[]): ExtensionContext {
  const chain = (table: string): unknown => new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve({ data: table === 'sie_account_mappings' ? stored : [], error: null })
      }
      return () => chain(table)
    },
  })
  const supabase = {
    from: vi.fn((table: string) => chain(table)),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    storage: memoryIntakeStorage().storage,
  }
  return { supabase, companyId: 'company-1', requestId: 'req-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
}

async function fetchSieData(ctx: ExtensionContext) {
  const res = await sieData(createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data', {
    searchParams: { consentId: 'consent-1', years: '2025,2026' },
  }), ctx)
  const { status, body } = await parseJsonResponse<{
    mappings: AccountMapping[]
    accounts: SIEAccount[]
    fileStatuses: { fiscalYear: number; storagePath: string; filename: string }[]
  }>(res)
  expect(status).toBe(200)
  return body
}

beforeEach(async () => {
  vi.clearAllMocks()
  ;(resolveConsent as Mock).mockResolvedValue({ consent: { provider: 'fortnox' }, accessToken: 'tok', providerCompanyId: undefined })
  ;(fetchAccountingAccountsDirect as Mock).mockResolvedValue([])
  ;(getAllowedFiscalYears as Mock).mockReturnValue(new Set([2025, 2026]))
  ;(fetchProviderSieFiles as Mock).mockResolvedValue({
    files: [{ fiscalYear: 2025, rawContent: FY2025 }, { fiscalYear: 2026, rawContent: FY2026 }],
    sourceYears: [],
    failedYears: [],
    omittedYears: [],
  })
  ;(buildMappingTargets as Mock).mockResolvedValue(BAS_REFERENCE.map((a) => ({ account_number: a.account_number, account_name: a.account_name })))
  // Job admission as it runs, up to the archive write: schema, parse, validate.
  const actual = await vi.importActual<typeof import('@/lib/import/sie-jobs')>('@/lib/import/sie-jobs')
  const { parseSIEFile } = await import('@/lib/import/sie-parser')
  const { SIEJobMappingsSchema, SIEJobOptionsSchema } = await import('@/lib/api/schemas')
  ;(submitSIEJob as Mock).mockImplementation(async (_s, _c, _u, content: string, mappings: unknown, options: Record<string, unknown>) => {
    actual.validateSIEJobInput(content, parseSIEFile(content), SIEJobMappingsSchema.parse(mappings),
      { ...SIEJobOptionsSchema.parse(options), filename: String(options.filename) })
    return { id: 'job-1', job_state: 'queued' }
  })
})

const STATES = [
  ['a stored 9xxx mapping from the earlier import', STORED_SELF_MAPS, []],
  ['9xxx rows already in the company chart', [], CHART_ROWS],
  ['a blank target', [], []],
] as const

describe('#3312: the onboarding provider step on a year with class 9 amounts', () => {
  it.each(STATES)('fetches, completes and submits FY2026 with %s', async (_label, stored, chartRows) => {
    if (chartRows.length) {
      ;(buildMappingTargets as Mock).mockResolvedValue([...chartRows,
        ...BAS_REFERENCE.map((a) => ({ account_number: a.account_number, account_name: a.account_name }))])
    }
    const ctx = buildCtx([...stored])
    const data = await fetchSieData(ctx)

    // /sie-data returns the upload's decision: class 9 amounts to 2999.
    for (const number of CLASS_9) {
      expect(data.mappings.find((m) => m.sourceAccount === number)).toMatchObject({ targetAccount: '2999', targetName: 'OBS-konto' })
    }

    // The step creates no class 9 account and maps nothing onto a 9xxx number.
    const resolved = resolveOnboardingMappings(data.mappings, data.accounts)
    expect(resolved.unresolved).toEqual([])
    expect(resolved.create).toEqual([])
    expect(resolved.mappings.some((m) => /^9\d{3}$/.test(m.targetAccount))).toBe(false)

    // FY2025 is already imported (#3279 skips it); FY2026 is the retry,
    // posted as the path /sie-data archived it under.
    const fy2026 = data.fileStatuses.find((f) => f.fiscalYear === 2026)!
    const res = await importSie(createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', {
      method: 'POST',
      body: { storagePath: fy2026.storagePath, filename: fy2026.filename, mappings: resolved.mappings, options: { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true } },
    }), ctx)
    const { status, body } = await parseJsonResponse<{ importId?: string; error?: { code: string } }>(res)
    expect(body.error?.code).toBeUndefined()
    expect(status).toBe(202)
    expect(body.importId).toBe('job-1')
    expect((submitSIEJob as Mock).mock.calls[0][3]).toBe(FY2026)
  })

  it('still refuses a class 9 target someone chose, naming it without sending the user out of the flow', async () => {
    const ctx = buildCtx([])
    const data = await fetchSieData(ctx)
    const chosen = data.mappings.map((m) => (m.sourceAccount === '9999' ? { ...m, targetAccount: '9998', targetName: 'Eget' } : m))
    const fy2026 = data.fileStatuses.find((f) => f.fiscalYear === 2026)!
    const res = await importSie(createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', {
      method: 'POST', body: { storagePath: fy2026.storagePath, filename: fy2026.filename, mappings: chosen, options: {} },
    }), ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; details: unknown } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS')
    expect(body.error.details).toEqual({ account_numbers: ['9998'] })
  })
})

describe('#63: only the accounts the files use', () => {
  it('names the definitions no selected year uses and hands the switch to the job', async () => {
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [
        { fiscalYear: 2025, rawContent: FY2025.replace('#KONTO 1930', '#KONTO 2440 "Leverantörsskulder"\n#KONTO 1930') },
        { fiscalYear: 2026, rawContent: FY2026 },
      ],
      sourceYears: [],
      failedYears: [],
      omittedYears: [],
    })
    const ctx = buildCtx([])
    const res = await sieData(createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data', {
      searchParams: { consentId: 'consent-1', years: '2025,2026' },
    }), ctx)
    const { status, body } = await parseJsonResponse<{
      mappings: AccountMapping[]
      preview: { unusedAccounts?: SIEAccount[] }
      fileStatuses: { fiscalYear: number; storagePath: string; filename: string }[]
    }>(res)
    expect(status).toBe(200)
    expect(body.preview.unusedAccounts?.map((account) => account.number)).toEqual(['2440'])
    // The default still maps it: the switch is the user's.
    expect(body.mappings.some((m) => m.sourceAccount === '2440')).toBe(true)

    const fy2026 = body.fileStatuses.find((f) => f.fiscalYear === 2026)!
    const imported = await importSie(createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', {
      method: 'POST',
      body: { storagePath: fy2026.storagePath, filename: fy2026.filename, mappings: body.mappings,
        options: { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true, onlyUsedAccounts: true } },
    }), ctx)
    expect(imported.status).toBe(202)
    expect((submitSIEJob as Mock).mock.calls[0][5]).toMatchObject({ onlyUsedAccounts: true })
  })
})
