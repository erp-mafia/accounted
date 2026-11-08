/**
 * POST /import-sie must answer a refusal from the SIE job RPCs with the same
 * structured code the manual upload route gives it. Wrapped as
 * SIE_IMPORT_UNEXPECTED (500, "The import outcome could not be confirmed") a
 * re-import of a year that already held an import reached the migration
 * wizard as an unknown outcome, although the RPC had refused and rolled back:
 * nine times for six users since 2026-09-14, one of them retrying twice.
 *
 * The refusals are built by the real jobDatabaseError, so these tests pin the
 * mapping from the raised sentence and SQLSTATE as well as the route.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/import/sie-resync', () => ({ planSIEResync: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/import/sie-import', () => ({ loadMappings: vi.fn(), generateImportPreview: vi.fn() }))
vi.mock('@/lib/import/sie-jobs', async (load) => ({
  ...await load<typeof import('@/lib/import/sie-jobs')>(),
  submitSIEJob: vi.fn(),
}))
vi.mock('next/server', async (load) => ({ ...await load<typeof import('next/server')>(), after: vi.fn() }))
vi.mock('@/lib/import/sie-job-worker', () => ({ runSIEWorker: vi.fn() }))

import { arcimMigrationExtension } from '../index'
import { createClient } from '@/lib/supabase/server'
import { submitSIEJob, jobDatabaseError } from '@/lib/import/sie-jobs'
import { planSIEResync } from '@/lib/import/sie-resync'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/import-sie',
)!.handler as RouteHandler

const SIE = [
  '#FLAGGA 0', '#SIETYP 4', '#FNAMN "Migrerad AB"', '#RAR 0 20260101 20261231',
  '#KONTO 1930 "Företagskonto"', '#KONTO 3001 "Försäljning"',
  '#VER A 1 20260115 "Sale"', '{', '#TRANS 1930 {} 100.00', '#TRANS 3001 {} -100.00', '}',
].join('\n')
const MAPPINGS = [
  { sourceAccount: '1930', sourceName: 'Företagskonto', targetAccount: '1930' },
  { sourceAccount: '3001', sourceName: 'Försäljning', targetAccount: '3001' },
]
const BODY = { rawContent: SIE, mappings: MAPPINGS, options: { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true } }

type Envelope = { error: { code: string; message: string; message_en: string; requestId?: string } }

function signIn(userId: string | null) {
  ;(createClient as Mock).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
  })
}

// No ctx.supabase: the handler resolves its client from @/lib/supabase/server.
const ctx = { companyId: 'company-1', requestId: 'req-9', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
const post = (body: Record<string, unknown>) => handler(
  createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', { method: 'POST', body }), ctx)

describe('POST /import-sie: job refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signIn('user-1')
    vi.mocked(planSIEResync).mockResolvedValue(null)
  })

  it('401 without a signed-in user', async () => {
    signIn(null)
    const response = await post(BODY)
    expect(response.status).toBe(401)
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('400 without the SIE content or mappings', async () => {
    const response = await post({ options: {} })
    expect(response.status).toBe(400)
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('409 SIE_IMPORT_PERIOD_ALREADY_IMPORTED when the year already holds an import', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'Existing SIE import requires reviewed replacement or reconciliation',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(409)
    expect(body.error).toMatchObject({ code: 'SIE_IMPORT_PERIOD_ALREADY_IMPORTED', requestId: 'req-9' })
    expect(body.error.message).toContain('importhistoriken')
    expect(body.error.message).not.toContain('kunde inte bekräftas')
  })

  it('409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED when the year to replace is a legacy import', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'Legacy SIE import requires reviewed reconciliation before replacement',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post({ ...BODY, options: { ...BODY.options, supersedesImportId: 'import-0' } }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SIE_IMPORT_LEGACY_REVIEW_REQUIRED')
  })

  it('409 CONFLICT for any other guard, never the existing-import sentence', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'SIE import is unfinished: resume or undo it',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
  })

  it('503 TRANSIENT_ERROR for a lock that is not available: a retry, not an existing import', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55P03', message: 'could not obtain lock on row in relation "fiscal_periods"',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(503)
    expect(body.error.code).toBe('TRANSIENT_ERROR')
    expect(body.error.message).toContain('försök igen')
  })

  it('keeps SIE_IMPORT_UNEXPECTED when the database never answered', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({ code: '', message: 'TypeError: fetch failed' }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(500)
    expect(body.error.code).toBe('SIE_IMPORT_UNEXPECTED')
  })

  it('202 with the import id when the job is accepted', async () => {
    ;(submitSIEJob as Mock).mockResolvedValueOnce({ id: 'import-1', job_state: 'queued' })
    const { status, body } = await parseJsonResponse<{ importId: string; state: string; statusUrl: string }>(await post(BODY))
    expect(status).toBe(202)
    expect(body).toMatchObject({ importId: 'import-1', state: 'queued', statusUrl: '/api/import/sie/import-1' })
    expect(submitSIEJob).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', SIE, MAPPINGS,
      expect.objectContaining({ onExistingPeriod: 'block' }), undefined)
  })
  it.each([true, false])('preserves the explicit no-document choice in a new job: %s', async markImportedNoDocRequired => {
    vi.mocked(submitSIEJob).mockResolvedValueOnce({ id: 'new-import', job_state: 'queued' } as never)
    const response = await post({ ...BODY, options: { ...BODY.options, markImportedNoDocRequired } })
    expect(response.status).toBe(202)
    expect(submitSIEJob).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', SIE, MAPPINGS,
      expect.objectContaining({ markImportedNoDocRequired }), undefined)
  })

  it('does not mark existing vouchers during a no-addition resync even with the choice enabled', async () => {
    vi.mocked(planSIEResync).mockResolvedValueOnce({ periodId: 'period', added: 0, unchanged: 12,
      reviewCount: 0, reviews: [], metadataChanged: false, newOrdinals: [] })
    const response = await post({ ...BODY, options: { ...BODY.options, markImportedNoDocRequired: true } })
    expect(response.status).toBe(200)
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('ignores an older client replacement request and admits only incremental additions', async () => {
    vi.mocked(planSIEResync).mockResolvedValueOnce({periodId:'period',added:1,unchanged:12,reviewCount:0,reviews:[],metadataChanged:false,newOrdinals:[12]})
    vi.mocked(submitSIEJob).mockResolvedValueOnce({id:'delta-1',job_state:'queued'} as never)
    const {status}=await parseJsonResponse(await post({...BODY,options:{...BODY.options,supersedesImportId:'old-import'}}))
    expect(status).toBe(202)
    expect(submitSIEJob).toHaveBeenCalledWith(expect.anything(),'company-1','user-1',expect.any(String),expect.any(Array),
      expect.objectContaining({onExistingPeriod:'incremental',importOpeningBalances:false,importTransactions:true,supersedesImportId:undefined}),undefined)
  })

  it('resolves a SIE4I file without RAR before planning its incremental comparison', async () => {
    const period = { period_start: '2026-01-01', period_end: '2026-12-31' }
    const bounds = { select: vi.fn(), eq: vi.fn(), lte: vi.fn(), gte: vi.fn(), limit: vi.fn() }
    bounds.select.mockReturnValue(bounds)
    bounds.eq.mockReturnValue(bounds)
    bounds.lte.mockReturnValue(bounds)
    bounds.gte.mockReturnValue(bounds)
    bounds.limit.mockResolvedValue({ data: [period], error: null })
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn().mockReturnValue(bounds),
    } as never)
    vi.mocked(planSIEResync).mockResolvedValueOnce({ periodId: 'period', added: 0, unchanged: 1,
      reviewCount: 0, reviews: [], metadataChanged: false, newOrdinals: [] })

    const { status, body } = await parseJsonResponse<{ result: { details: { fiscalYear: { start: string; end: string } } } }>(
      await post({ ...BODY, rawContent: SIE.replace('#RAR 0 20260101 20261231\n', '') }),
    )

    expect(status).toBe(200)
    expect(bounds.eq).toHaveBeenCalledWith('company_id', 'company-1')
    expect(vi.mocked(planSIEResync).mock.calls[0][3].stats).toMatchObject({
      fiscalYearStart: period.period_start, fiscalYearEnd: period.period_end,
    })
    expect(body.result.details.fiscalYear).toEqual({ start: period.period_start, end: period.period_end })
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('returns current reviews without admitting a job when there are no additions', async () => {
    vi.mocked(planSIEResync).mockResolvedValueOnce({periodId:'closed-period',added:0,unchanged:12,reviewCount:1,
      reviews:[{sourceId:'A2',kind:'changed',entryId:'posted'}],metadataChanged:false,newOrdinals:[]})
    const {status,body}=await parseJsonResponse<{result:{resync:{reviewCount:number};journalEntriesCreated:number}}>(await post(BODY))
    expect(status).toBe(200)
    expect(body.result).toMatchObject({journalEntriesCreated:0,resync:{unchanged:12,reviewCount:1}})
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

})
