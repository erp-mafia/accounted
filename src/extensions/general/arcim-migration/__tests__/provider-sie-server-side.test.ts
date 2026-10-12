/**
 * Provider SIE files stay on the server.
 *
 * GET /sie-data used to answer with every fetched file's text (and the whole
 * merged parse), and the wizard posted that text back to POST /import-sie.
 * Both bodies hit the hosting gateway's 4.5 MB limit, so a large company's
 * migration could not start. Now /sie-data archives each file in the SIE
 * intake and answers with its path; /import-sie reads the file from there,
 * and only from the active company's own intake.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockRequest, createMockSupabase, parseJsonResponse } from '@/tests/helpers'

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
vi.mock('../lib/mapping-targets', () => ({ buildMappingTargets: vi.fn().mockResolvedValue([]) }))
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
import { submitSIEJob } from '@/lib/import/sie-jobs'
import { memoryIntakeStorage, intakePath } from './intake-storage'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const route = (method: string, path: string) =>
  (arcimMigrationExtension.apiRoutes ?? []).find((r) => r.method === method && r.path === path)!.handler as RouteHandler
const sieData = route('GET', '/sie-data')
const importSie = route('POST', '/import-sie')

/** Vercel's request and response body limit for a function. */
const GATEWAY_BODY_LIMIT = 4.5 * 1024 * 1024

function sieYear(year: number, vouchers: number): string {
  const lines = [
    '#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Bolaget AB"', `#RAR 0 ${year}0101 ${year}1231`,
    '#KONTO 1930 "Företagskonto"', '#KONTO 3001 "Försäljning tjänster"',
  ]
  for (let i = 1; i <= vouchers; i++) {
    lines.push(`#VER A ${i} ${year}0115 "Faktura ${i} till kund med en lång beskrivning av uppdraget"`, '{',
      '#TRANS 1930 {} 1250.00', '#TRANS 3001 {} -1250.00', '}')
  }
  return lines.join('\n') + '\n'
}

const FY2025 = sieYear(2025, 3)
const FY2026 = sieYear(2026, 5)
const MAPPINGS = [
  { sourceAccount: '1930', sourceName: 'Företagskonto', targetAccount: '1930' },
  { sourceAccount: '3001', sourceName: 'Försäljning tjänster', targetAccount: '3001' },
]
const OPTIONS = { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true }

/** Every table query answers an empty list; storage is the in-memory bucket. */
function buildCtx(opts: { userId?: string | null; files?: Record<string, string> } = {}) {
  const { supabase, mockResult } = createMockSupabase()
  mockResult({ data: [], count: 0 })
  const intake = memoryIntakeStorage(opts.files)
  const userId = opts.userId === undefined ? 'user-1' : opts.userId
  Object.assign(supabase, {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
    storage: intake.storage,
  })
  const ctx = { supabase, companyId: 'company-1', requestId: 'req-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
  return { ctx, intake }
}

const getSieData = (ctx: ExtensionContext) => sieData(createMockRequest(
  'http://localhost/api/extensions/ext/arcim-migration/sie-data',
  { searchParams: { consentId: 'consent-1', years: '2025,2026' } },
), ctx)

function postImport(body: Record<string, unknown>, ctx: ExtensionContext) {
  const request = createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', { method: 'POST', body })
  return { request, response: importSie(request.clone(), ctx) }
}

type FileStatus = { fiscalYear: number; storagePath: string; filename: string; bytes: number; voucherCount: number }

beforeEach(() => {
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
  ;(submitSIEJob as Mock).mockResolvedValue({ id: 'job-1', job_state: 'queued' })
})

describe('GET /sie-data: archives each file and answers with its path', () => {
  it('archives every fetched year in the company intake and returns paths, sizes and counts, no content', async () => {
    const { ctx, intake } = buildCtx()
    const res = await getSieData(ctx)
    const text = await res.clone().text()
    const { status, body } = await parseJsonResponse<{
      fileStatuses: FileStatus[]
      accounts: { number: string }[]
      theater: { totalVouchers: number; years: unknown[] }
    }>(res)

    expect(status).toBe(200)
    expect(body.fileStatuses.map((f) => f.fiscalYear)).toEqual([2025, 2026])
    for (const [i, content] of [FY2025, FY2026].entries()) {
      const f = body.fileStatuses[i]
      expect(f.storagePath).toMatch(/^company-1\/sie-intake\/[a-f0-9-]{36}\.se$/)
      expect(f.filename).toBe(`migration-sie-${f.fiscalYear}.se`)
      expect(f.bytes).toBe(Buffer.byteLength(content, 'utf8'))
      expect(await intake.files.get(f.storagePath)!.text()).toBe(content)
    }
    expect(body.fileStatuses.map((f) => f.voucherCount)).toEqual([3, 5])
    // The theater and the account list come built; no file text, no parse.
    expect(body.theater.totalVouchers).toBe(8)
    expect(body.accounts.map((a) => a.number)).toEqual(['1930', '3001'])
    expect(body).not.toHaveProperty('rawContent')
    expect(body).not.toHaveProperty('parsed')
    expect(text).not.toContain('#VER')
    expect(text).not.toContain('#TRANS')
  })

  it('archives a re-fetched export onto the same path instead of a second copy', async () => {
    const { ctx, intake } = buildCtx()
    const first = await parseJsonResponse<{ fileStatuses: FileStatus[] }>(await getSieData(ctx))
    const second = await parseJsonResponse<{ fileStatuses: FileStatus[] }>(await getSieData(ctx))
    expect(second.body.fileStatuses.map((f) => f.storagePath)).toEqual(first.body.fileStatuses.map((f) => f.storagePath))
    expect(intake.files.size).toBe(2)
  })
})

describe('POST /import-sie: reads the file by path, only from the active company', () => {
  const OWN = intakePath('company-1')

  it('401 without a signed-in user', async () => {
    const { ctx } = buildCtx({ userId: null, files: { [OWN]: FY2026 } })
    const { response } = postImport({ storagePath: OWN, mappings: MAPPINGS, options: OPTIONS }, ctx)
    expect((await response).status).toBe(401)
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('400 for the old shape that posted the content itself', async () => {
    const { ctx, intake } = buildCtx()
    const { response } = postImport({ rawContent: FY2026, mappings: MAPPINGS, options: OPTIONS }, ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(intake.bucket.download).not.toHaveBeenCalled()
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('403 for another company\'s file, without asking storage', async () => {
    const foreign = intakePath('company-2')
    const { ctx, intake } = buildCtx({ files: { [foreign]: FY2026 } })
    const { response } = postImport({ storagePath: foreign, mappings: MAPPINGS, options: OPTIONS }, ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toContain('hör inte till det här företaget')
    expect(intake.bucket.download).not.toHaveBeenCalled()
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it.each([
    ['a traversal behind the company prefix', 'company-1/sie-intake/../../company-2/sie-intake/0f8fad5b-d9cb-469f-a165-70867728950e.se'],
    ['the archive of a submitted job', 'company-1/sie-jobs/0f8fad5b-d9cb-469f-a165-70867728950e.se'],
    ['a made-up key', 'company-1/sie-intake/export.se'],
  ])('403 for %s', async (_label, storagePath) => {
    const { ctx, intake } = buildCtx()
    const { response } = postImport({ storagePath, mappings: MAPPINGS, options: OPTIONS }, ctx)
    expect((await response).status).toBe(403)
    expect(intake.bucket.download).not.toHaveBeenCalled()
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('404 for a well-formed own path with no file', async () => {
    const { ctx } = buildCtx()
    const { response } = postImport({ storagePath: OWN, mappings: MAPPINGS, options: OPTIONS }, ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toContain('Hämta bokföringsdatan')
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('202 for the company\'s own file: the job gets its text and the original file', async () => {
    const { ctx } = buildCtx({ files: { [OWN]: FY2026 } })
    const { response } = postImport({ storagePath: OWN, filename: 'migration-sie-2026.se', mappings: MAPPINGS, options: OPTIONS }, ctx)
    const { status, body } = await parseJsonResponse<{ importId: string }>(await response)
    expect(status).toBe(202)
    expect(body.importId).toBe('job-1')
    const [, companyId, userId, content, mappings, , original] = (submitSIEJob as Mock).mock.calls[0]
    expect([companyId, userId, content, mappings]).toEqual(['company-1', 'user-1', FY2026, MAPPINGS])
    expect(original).toBeInstanceOf(File)
    expect((original as File).name).toBe('migration-sie-2026.se')
  })
})

describe('a file larger than the gateway body limit never passes through a body', () => {
  it('fetches, archives and imports a 5 MB year with small bodies both ways', async () => {
    const large = sieYear(2026, 40_000)
    expect(Buffer.byteLength(large, 'utf8')).toBeGreaterThan(GATEWAY_BODY_LIMIT)
    ;(fetchProviderSieFiles as Mock).mockResolvedValue({
      files: [{ fiscalYear: 2026, rawContent: large }], sourceYears: [], failedYears: [], omittedYears: [],
    })
    const { ctx, intake } = buildCtx()

    const res = await getSieData(ctx)
    const responseBytes = (await res.clone().arrayBuffer()).byteLength
    const { status, body } = await parseJsonResponse<{ fileStatuses: FileStatus[] }>(res)
    expect(status).toBe(200)
    expect(responseBytes).toBeLessThan(64 * 1024)
    const [file] = body.fileStatuses
    expect(file.bytes).toBeGreaterThan(GATEWAY_BODY_LIMIT)
    expect(await intake.files.get(file.storagePath)!.text()).toBe(large)

    const { request, response } = postImport({ storagePath: file.storagePath, filename: file.filename, mappings: MAPPINGS, options: OPTIONS }, ctx)
    const requestBytes = (await request.arrayBuffer()).byteLength
    expect(requestBytes).toBeLessThan(4 * 1024)
    expect((await response).status).toBe(202)
    expect((submitSIEJob as Mock).mock.calls[0][3]).toBe(large)
  }, 60_000)
})
