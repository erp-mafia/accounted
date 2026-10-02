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
})
