/**
 * A source-system account (0xxx) that carries amounts reaches the mapping
 * page, and the year is not imported until it has a target.
 *
 * 2026-10-22: /sie-data left every 0xxx account out of the mapping list, used
 * or not. A company that booked its supplier costs on 0999 was never asked
 * for a target, /import-sie saw no blank row, and the job skipped the 65
 * payments on it and finished as completed: 1930 and 2641 were put right by
 * one year-end adjustment verifikat and 257 981,82 kr of cost landed on 3740
 * Öresutjämning.
 *
 * The chain as the wizard runs it: GET /sie-data, then POST /import-sie with
 * the path /sie-data archived the year under, whose job admission runs the
 * real validator.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

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
import { canSkipMappingStep } from '../lib/mapping-step'
import { submitSIEJob } from '@/lib/import/sie-jobs'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import type { AccountMapping } from '@/lib/import/types'
import { FORTNOX_YEAR } from '@/lib/import/__tests__/fixtures/fortnox-source-system-accounts'
import { memoryIntakeStorage } from './intake-storage'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const route = (method: string, path: string) =>
  (arcimMigrationExtension.apiRoutes ?? []).find((r) => r.method === method && r.path === path)!.handler as RouteHandler
const sieData = route('GET', '/sie-data')
const importSie = route('POST', '/import-sie')

// Every table read answers empty: no stored mappings, no earlier imports.
function buildCtx(): ExtensionContext {
  const { supabase } = createTableMockSupabase()
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  Object.assign(supabase, { storage: memoryIntakeStorage().storage })
  return { supabase, companyId: 'company-1', requestId: 'req-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
}

type SieData = {
  mappings: AccountMapping[]
  preview: { mappingStatus: { unmapped: number } }
  fileStatuses: { fiscalYear: number; storagePath: string; filename: string }[]
}

async function fetchSieData(ctx: ExtensionContext): Promise<SieData> {
  const res = await sieData(createMockRequest('http://localhost/api/extensions/ext/arcim-migration/sie-data', {
    searchParams: { consentId: 'consent-1', years: '2026' },
  }), ctx)
  const { status, body } = await parseJsonResponse<SieData>(res)
  expect(status).toBe(200)
  return body
}

const submit = (ctx: ExtensionContext, file: SieData['fileStatuses'][number], mappings: AccountMapping[]) =>
  importSie(createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', {
    method: 'POST',
    body: { storagePath: file.storagePath, filename: file.filename, mappings,
      options: { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true } },
  }), ctx)

beforeEach(async () => {
  vi.clearAllMocks()
  ;(resolveConsent as Mock).mockResolvedValue({ consent: { provider: 'fortnox' }, accessToken: 'tok', providerCompanyId: undefined })
  ;(fetchAccountingAccountsDirect as Mock).mockResolvedValue([])
  ;(getAllowedFiscalYears as Mock).mockReturnValue(new Set([2026]))
  ;(fetchProviderSieFiles as Mock).mockResolvedValue({
    files: [{ fiscalYear: 2026, rawContent: FORTNOX_YEAR }], sourceYears: [], failedYears: [], omittedYears: [],
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

describe('provider migration: a 0xxx account with amounts', () => {
  it('lists the company\'s own 0999 for a target and leaves Fortnox 0099 out', async () => {
    const data = await fetchSieData(buildCtx())
    expect(data.mappings.find((m) => m.sourceAccount === '0999')).toMatchObject({ sourceName: 'Inköp gården', targetAccount: '' })
    expect(data.mappings.some((m) => m.sourceAccount === '0099')).toBe(false)
    // The wizard cannot go past its mapping page with a blank target.
    expect(data.preview.mappingStatus.unmapped).toBe(1)
    expect(canSkipMappingStep(data.mappings, { unmapped: data.preview.mappingStatus.unmapped })).toBe(false)
  })

  it('refuses the year while 0999 has no target, with the sentence that names it', async () => {
    const ctx = buildCtx()
    const data = await fetchSieData(ctx)
    // The list as it was sent on 2026-10-22: no row for 0999 at all.
    const hidden = data.mappings.filter((m) => m.sourceAccount !== '0999')
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; details: Record<string, unknown> } }>(
      await submit(ctx, data.fileStatuses[0], hidden))
    expect(status).toBe(400)
    expect(body.error.code).toBe('SIE_IMPORT_UNMAPPED_ACCOUNTS')
    expect(body.error.message).toContain('0999 Inköp gården (2 verifikationer, till exempel E12)')
    expect(body.error.message).toContain('Välj målkonto för kontot i kontomappningen')
    expect(body.error.details.accounts_without_target).toEqual([
      { account: '0999', name: 'Inköp gården', vouchers: 2, first_voucher: 'E12', opening_balance: 0 },
    ])
  })

  it('starts the import once the person has chosen a target for 0999', async () => {
    const ctx = buildCtx()
    const data = await fetchSieData(ctx)
    const chosen = data.mappings.map((m) => (m.sourceAccount === '0999' ? { ...m, targetAccount: '4010', targetName: 'Inköp material och varor' } : m))
    const { status, body } = await parseJsonResponse<{ importId?: string; error?: { code: string } }>(
      await submit(ctx, data.fileStatuses[0], chosen))
    expect(body.error?.code).toBeUndefined()
    expect(status).toBe(202)
    expect(body.importId).toBe('job-1')
  })
})
