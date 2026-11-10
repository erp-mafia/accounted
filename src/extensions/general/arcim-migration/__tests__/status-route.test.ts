import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * GET /status: the wizard's "SIE krävs först" gate for Visma/Bokio used to be
 * derived on the client from the 10 NEWEST sie_imports of ANY status, so a
 * company whose completed import was followed by ten failed or replaced rows
 * was gated as if it had never imported. The endpoint now answers the
 * question itself, with a status = 'completed' predicate and limit 1, the
 * same predicate the /migrate guard uses.
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
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

vi.mock('@/lib/invoices/bulk-reconcile-supplier-vouchers', () => ({
  reconcileSupplierInvoiceVouchers: vi.fn(),
}))

vi.mock('../lib/relink-registration-vouchers', () => ({
  relinkRegistrationVouchers: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('../lib/key-use', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/key-use')>()),
  readProviderKeyUseFacts: vi.fn(),
}))

vi.mock('../lib/replaced-copy-underlag', () => ({
  countUnderlagOnReplacedCopies: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { listConsents } from '../lib/provider-client'
import { readProviderKeyUseFacts } from '../lib/key-use'
import { countUnderlagOnReplacedCopies } from '../lib/replaced-copy-underlag'
import { createServiceClient } from '@/lib/supabase/server'
import { SIE_IMPORT_IN_PLACE_JOB_FILTER } from '@/lib/bookkeeping/sie-import-in-place'

const route = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'GET' && r.path === '/status',
)!
type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = route.handler as RouteHandler

type Row = Record<string, unknown>
type StatusBody = {
  sieImports: Row[]
  hasCompletedSieImport: boolean
  latestCompletedSieImport: Row | null
  unfinishedConnect: { provider: string; startedAt: string } | null
}
type RecordedQuery = { table: string; filters: [string, unknown][]; limit?: number; single: boolean }

/**
 * Table-aware Supabase mock: sie_imports answers the history list from
 * `history` and the completed-only lookup from `latestCompleted`; the count
 * tables answer 0. Every query is recorded so the predicate can be asserted.
 */
function buildSupabase(opts: { history: Row[]; latestCompleted: Row | null; user?: { id: string } | null }) {
  const queries: RecordedQuery[] = []
  const from = vi.fn((table: string) => {
    const q: RecordedQuery = { table, filters: [], single: false }
    queries.push(q)
    const resolve = () => {
      if (table !== 'sie_imports') return { data: null, error: null, count: 0 }
      const completedOnly = q.filters.some(([column, value]) => column === 'status' && value === 'completed')
      if (q.single) return { data: completedOnly ? opts.latestCompleted : null, error: null }
      return { data: completedOnly ? opts.history.filter((r) => r.status === 'completed') : opts.history, error: null }
    }
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn((column: string, value: unknown) => {
      q.filters.push([column, value])
      return chain
    })
    chain.or = vi.fn((filters: string) => {
      q.filters.push(['or', filters])
      return chain
    })
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn((n: number) => {
      q.limit = n
      return chain
    })
    chain.maybeSingle = vi.fn(() => {
      q.single = true
      return Promise.resolve(resolve())
    })
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected)
    return chain
  })
  const user = opts.user === undefined ? { id: 'user-1' } : opts.user
  const supabase = { from, auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } }
  return { supabase, queries }
}

function buildCtx(supabase: unknown): ExtensionContext {
  return { supabase, companyId: 'company-1', log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } as unknown as ExtensionContext
}

function statusRequest() {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/status', { method: 'GET' })
}

function sieRow(id: string, status: string, createdAt: string): Row {
  return {
    id,
    filename: `${id}.se`,
    status,
    accounts_count: status === 'completed' ? 120 : null,
    transactions_count: status === 'completed' ? 840 : null,
    company_name: 'Bolaget AB',
    fiscal_year_start: '2025-01-01',
    fiscal_year_end: '2025-12-31',
    imported_at: status === 'completed' ? createdAt : null,
    created_at: createdAt,
  }
}

/**
 * In-memory service client for the unfinished-connect lookup: each table is
 * a row list, and eq / gt / order / limit filter it the way PostgREST would,
 * so the assertions hold for the predicate rather than for a scripted answer.
 */
function buildService(tables: Record<string, Row[]>) {
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])]
    let limit: number | undefined
    const result = () => (limit === undefined ? rows : rows.slice(0, limit))
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn((column: string, value: unknown) => {
      rows = rows.filter((r) => r[column] === value)
      return chain
    })
    chain.gt = vi.fn((column: string, value: string) => {
      rows = rows.filter((r) => String(r[column]) > value)
      return chain
    })
    // The one or() the route asks: the job half of whereSieImportInPlace.
    chain.or = vi.fn((filters: string) => {
      if (filters !== SIE_IMPORT_IN_PLACE_JOB_FILTER) throw new Error(`unexpected or(${filters})`)
      rows = rows.filter((r) => r.job_state == null || (r.job_state === 'completed' && (r.job_kind ?? 'import') === 'import'))
      return chain
    })
    chain.order = vi.fn((column: string, opts?: { ascending?: boolean }) => {
      const dir = opts?.ascending === false ? -1 : 1
      rows.sort((a, b) => (String(a[column]) < String(b[column]) ? -dir : dir))
      return chain
    })
    chain.limit = vi.fn((n: number) => {
      limit = n
      return chain
    })
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: result()[0] ?? null, error: null }))
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve({ data: result(), error: null }).then(onFulfilled, onRejected)
    return chain
  })
  return { from }
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

describe('GET /status: completed SIE import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(listConsents as Mock).mockResolvedValue([])
    ;(createServiceClient as Mock).mockReturnValue(buildService({}))
  })

  it('reports a completed import that ten newer failed rows pushed out of the history window', async () => {
    const history = Array.from({ length: 10 }, (_, i) => sieRow(`failed-${i}`, 'failed', `2026-09-1${i % 10}T10:00:00Z`))
    const completed = sieRow('sie-old', 'completed', '2026-08-01T10:00:00Z')
    const { supabase, queries } = buildSupabase({ history, latestCompleted: completed })

    const res = await handler(statusRequest(), buildCtx(supabase))
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.hasCompletedSieImport).toBe(true)
    expect(body.latestCompletedSieImport?.id).toBe('sie-old')
    // The display history is unchanged: still the ten newest rows of any status.
    expect(body.sieImports.map((r) => r.id)).toEqual(history.map((r) => r.id))

    // The question is answered server-side: status = 'completed', company-scoped, limit 1.
    const completedQuery = queries.find(
      (q) => q.table === 'sie_imports' && q.filters.some(([c, v]) => c === 'status' && v === 'completed'),
    )
    expect(completedQuery).toBeDefined()
    expect(completedQuery!.filters).toContainEqual(['company_id', 'company-1'])
    // In place: not an import being undone, not a duplicate repair row.
    expect(completedQuery!.filters).toContainEqual(['or', 'job_state.is.null,and(job_state.eq.completed,job_kind.eq.import)'])
    expect(completedQuery!.limit).toBe(1)
    expect(completedQuery!.single).toBe(true)
  })

  it('answers false for a company that never completed an import', async () => {
    const history = [sieRow('failed-1', 'failed', '2026-09-10T10:00:00Z')]
    const { supabase } = buildSupabase({ history, latestCompleted: null })

    const res = await handler(statusRequest(), buildCtx(supabase))
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.hasCompletedSieImport).toBe(false)
    expect(body.latestCompletedSieImport).toBeNull()
  })

})

/**
 * GET /status `unfinishedConnect`: the company's latest connect that never got
 * a token, so the wizard can offer "Försök igen" or a SIE upload to a
 * returning customer. The consent row is the record of the attempt; no table
 * of its own.
 */
describe('GET /status: unfinished connect', () => {
  const attempt = (overrides: Row = {}): Row => ({
    id: 'consent-attempt',
    company_id: 'company-1',
    provider: 'fortnox',
    status: 0,
    created_at: minutesAgo(120),
    ...overrides,
  })

  async function statusWith(tables: Record<string, Row[]>, user?: { id: string } | null) {
    const service = buildService(tables)
    ;(createServiceClient as Mock).mockReturnValue(service)
    const { supabase } = buildSupabase({ history: [], latestCompleted: null, user })
    const res = await handler(statusRequest(), buildCtx(supabase))
    return { res, service }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(listConsents as Mock).mockResolvedValue([])
  })

  it('reports a token-less attempt older than 30 minutes', async () => {
    const own = attempt()
    const { res } = await statusWith({
      provider_consents: [
        own,
        // Another company's newer attempt must never surface here.
        attempt({ id: 'foreign', company_id: 'company-2', provider: 'visma', created_at: minutesAgo(40) }),
      ],
      // A completed import BEFORE the attempt does not mean the customer moved on.
      sie_imports: [{ id: 'sie-old', company_id: 'company-1', status: 'completed', created_at: minutesAgo(600) }],
    })
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.unfinishedConnect).toEqual({ provider: 'fortnox', startedAt: own.created_at })
  })

  it('answers null when the attempt has a token row', async () => {
    const { res } = await statusWith({
      provider_consents: [attempt()],
      provider_consent_tokens: [{ consent_id: 'consent-attempt' }],
    })
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.unfinishedConnect).toBeNull()
  })

  it('answers null when a completed SIE import was created after the attempt', async () => {
    const { res } = await statusWith({
      provider_consents: [attempt()],
      sie_imports: [{ id: 'sie-new', company_id: 'company-1', status: 'completed', created_at: minutesAgo(60) }],
    })
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.unfinishedConnect).toBeNull()
  })

  it('still reports the attempt when the SIE import after it is being undone', async () => {
    // request_sie_import_undo leaves status 'completed': the job is the state.
    const { res } = await statusWith({
      provider_consents: [attempt()],
      sie_imports: [{
        id: 'sie-new', company_id: 'company-1', status: 'completed', job_state: 'undoing', job_kind: 'import', created_at: minutesAgo(60),
      }],
    })
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.unfinishedConnect).toMatchObject({ provider: 'fortnox' })
  })

  it('answers null for an attempt younger than 30 minutes', async () => {
    const { res, service } = await statusWith({ provider_consents: [attempt({ created_at: minutesAgo(10) })] })
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.unfinishedConnect).toBeNull()
    // Still in progress: no need to look for a token.
    expect(service.from).not.toHaveBeenCalledWith('provider_consent_tokens')
  })

  it('answers null when the same provider is already connected', async () => {
    const { res } = await statusWith({
      provider_consents: [
        attempt(),
        attempt({ id: 'accepted', status: 1, created_at: minutesAgo(600) }),
      ],
    })
    const { body } = await parseJsonResponse<StatusBody>(res)

    expect(res.status).toBe(200)
    expect(body.unfinishedConnect).toBeNull()
  })
})

/**
 * GET /status `enabledProviders`: the wizard showed a WINT card from its own
 * hard-coded list while WINT_MIGRATION_ENABLED was off, and the card's
 * connect was then refused by the /connect gate. The status names the
 * providers this deployment can connect.
 */
describe('GET /status: enabled providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(listConsents as Mock).mockResolvedValue([])
    ;(createServiceClient as Mock).mockReturnValue(buildService({}))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function enabledProviders(): Promise<string[]> {
    const { supabase } = buildSupabase({ history: [], latestCompleted: null })
    const res = await handler(statusRequest(), buildCtx(supabase))
    const { body } = await parseJsonResponse<{ enabledProviders: string[] }>(res)
    expect(res.status).toBe(200)
    return body.enabledProviders
  }

  it('leaves WINT out while the launch switch is off', async () => {
    vi.stubEnv('WINT_MIGRATION_ENABLED', '')
    const providers = await enabledProviders()
    expect(providers).not.toContain('wint')
    expect(providers).toEqual(expect.arrayContaining(['fortnox', 'visma', 'bokio', 'bjornlunden', 'briox']))
  })

  it('names WINT once the switch is on', async () => {
    vi.stubEnv('WINT_MIGRATION_ENABLED', 'true')
    expect(await enabledProviders()).toContain('wint')
  })
})

describe('GET /status: latest underlag run (crm#1410)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(listConsents as Mock).mockResolvedValue([])
    ;(createServiceClient as Mock).mockReturnValue(buildService({}))
  })

  const STORED_RUN = {
    provider: 'fortnox',
    startedAt: '2026-10-22T08:53:31Z',
    updatedAt: '2026-10-22T09:20:11Z',
    complete: true,
    total: 3003,
    scanned: 3003,
    linked: 0,
    skipped: 2971,
    unmatched: 27,
    failed: 0,
    locked: 5,
    lockedPeriods: ['2020/2021'],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: null,
  }

  async function latestDocumentImport(stored: unknown, latestCompleted: Row | null = null) {
    const { supabase } = buildSupabase({ history: [], latestCompleted })
    const ctx = buildCtx(supabase)
    const get = vi.fn().mockResolvedValue(stored)
    ;(ctx as unknown as { settings: unknown }).settings = { get, set: vi.fn(), clear: vi.fn() }
    const res = await handler(statusRequest(), ctx)
    const { body } = await parseJsonResponse<{ latestDocumentImport: unknown }>(res)
    expect(res.status).toBe(200)
    return { body, get }
  }

  it('hands the stored run to the connections list after a reload', async () => {
    const { body, get } = await latestDocumentImport(STORED_RUN)

    expect(get).toHaveBeenCalledWith('document_import_run')
    expect(body.latestDocumentImport).toEqual({ ...STORED_RUN, stalled: false, continuesOnServer: false })
  })

  it('answers null before any run, and for a value that is not a run', async () => {
    expect((await latestDocumentImport(null)).body.latestDocumentImport).toBeNull()
    expect((await latestDocumentImport({ linked: 3 })).body.latestDocumentImport).toBeNull()
  })

  describe('a silent run the server picks up again (crm#1581)', () => {
    const silent = {
      ...STORED_RUN,
      startedAt: minutesAgo(25 * 60),
      updatedAt: minutesAgo(24 * 60),
      complete: false,
      scanned: 2740,
      nextCursor: 'file-2740',
      needsReconnect: false,
    }
    const fortnoxConsent = (createdAt: string) => ({
      id: 'consent-1', provider: 'fortnox', status: 1, companyName: 'Hreidur AB', createdAt,
    })

    // A connection makes the route read the key's use too; it says nothing here.
    beforeEach(() => {
      ;(readProviderKeyUseFacts as Mock).mockRejectedValue(new Error('not under test'))
    })

    it('says so when its connection and the ledger are older than the run', async () => {
      ;(listConsents as Mock).mockResolvedValue([fortnoxConsent(minutesAgo(26 * 60))])

      const { body } = await latestDocumentImport(silent, sieRow('sie-1', 'completed', minutesAgo(25.5 * 60)))

      expect(body.latestDocumentImport).toMatchObject({ stalled: true, continuesOnServer: true })
    })

    it('does not once a ledger import landed after it started, or no connection is known', async () => {
      ;(listConsents as Mock).mockResolvedValue([fortnoxConsent(minutesAgo(26 * 60))])
      const afterLedger = await latestDocumentImport(silent, sieRow('sie-2', 'completed', minutesAgo(60)))
      expect(afterLedger.body.latestDocumentImport).toMatchObject({ stalled: true, continuesOnServer: false })

      ;(listConsents as Mock).mockResolvedValue([])
      const noConnection = await latestDocumentImport(silent)
      expect(noConnection.body.latestDocumentImport).toMatchObject({ continuesOnServer: false })
    })
  })
})

/**
 * GET /status `consents[].keyUse` (crm#1476, PH 219): whether each stored key
 * still has work to do, so a finished migration can say the key is no longer
 * used and offer to remove it.
 */
describe('GET /status: what each stored key is still for', () => {
  const consent = (id: string, createdAt: string) => ({ id, provider: 'bokio', status: 1, companyName: 'Bolaget AB', createdAt })

  beforeEach(() => {
    vi.clearAllMocks()
    ;(createServiceClient as Mock).mockReturnValue(buildService({}))
    // Newest first, as listConsents orders them.
    ;(listConsents as Mock).mockResolvedValue([consent('consent-new', '2026-10-20'), consent('consent-old', '2026-09-01')])
  })

  it('tags the connection the invoice-row pass reads with, and calls the other idle', async () => {
    ;(readProviderKeyUseFacts as Mock).mockResolvedValue({
      jobStates: ['completed'],
      importedWithoutJob: false,
      invoicesAwaitingRows: true,
      supplierCompletionConsentIds: new Set(),
      newestConsentId: 'consent-new',
    })
    const { supabase } = buildSupabase({ history: [], latestCompleted: null })

    const res = await handler(statusRequest(), buildCtx(supabase))
    const { body } = await parseJsonResponse<{ consents: { id: string; keyUse?: string }[] }>(res)

    expect(res.status).toBe(200)
    expect(body.consents.map((c) => [c.id, c.keyUse])).toEqual([
      ['consent-new', 'invoice_rows'],
      ['consent-old', 'idle'],
    ])
    expect(readProviderKeyUseFacts).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      hasCompletedSieImport: false,
      importedRecords: 0,
      newestConsentId: 'consent-new',
    })
  })

  it('says nothing about the key when the read fails, and still answers', async () => {
    ;(readProviderKeyUseFacts as Mock).mockRejectedValue(new Error('PROVIDER_KEY_USE_READ_FAILED'))
    const { supabase } = buildSupabase({ history: [], latestCompleted: null })

    const res = await handler(statusRequest(), buildCtx(supabase))
    const { body } = await parseJsonResponse<{ consents: { id: string; keyUse?: string }[] }>(res)

    expect(res.status).toBe(200)
    expect(body.consents).toHaveLength(2)
    expect(body.consents.every((c) => c.keyUse === undefined)).toBe(true)
  })

  it('does not read for a company with no connection', async () => {
    ;(listConsents as Mock).mockResolvedValue([])
    const { supabase } = buildSupabase({ history: [], latestCompleted: null })

    await handler(statusRequest(), buildCtx(supabase))

    expect(readProviderKeyUseFacts).not.toHaveBeenCalled()
  })
})

/**
 * GET /status `underlagOnReplacedCopies` (#51): live verifikat whose underlag
 * an earlier run left on the copy a re-run migration reversed, so the page
 * can offer "Hämta underlag" again. Asked only where that run can go.
 */
describe('GET /status: underlag left on reversed copies (#51)', () => {
  const consent = (provider: string) => ({ id: `consent-${provider}`, provider, status: 1, companyName: 'Bolaget AB', createdAt: '2026-10-01' })
  const completed = sieRow('sie-1', 'completed', '2026-10-02T10:00:00Z')

  beforeEach(() => {
    vi.clearAllMocks()
    ;(createServiceClient as Mock).mockReturnValue(buildService({}))
    ;(readProviderKeyUseFacts as Mock).mockRejectedValue(new Error('not under test'))
    ;(countUnderlagOnReplacedCopies as Mock).mockResolvedValue(12)
  })

  async function underlagOnReplacedCopies(latestCompleted: Row | null) {
    const { supabase } = buildSupabase({ history: [], latestCompleted })
    const res = await handler(statusRequest(), buildCtx(supabase))
    const { body } = await parseJsonResponse<{ underlagOnReplacedCopies: number }>(res)
    expect(res.status).toBe(200)
    return { count: body.underlagOnReplacedCopies, supabase }
  }

  it('counts them for a company with a ledger import and a connection that serves underlag', async () => {
    ;(listConsents as Mock).mockResolvedValue([consent('fortnox')])

    const { count, supabase } = await underlagOnReplacedCopies(completed)

    expect(count).toBe(12)
    expect(countUnderlagOnReplacedCopies).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('does not ask before a ledger import', async () => {
    ;(listConsents as Mock).mockResolvedValue([consent('bokio')])

    expect((await underlagOnReplacedCopies(null)).count).toBe(0)
    expect(countUnderlagOnReplacedCopies).not.toHaveBeenCalled()
  })

  it('does not ask when no connection can fetch underlag', async () => {
    ;(listConsents as Mock).mockResolvedValue([consent('visma')])

    expect((await underlagOnReplacedCopies(completed)).count).toBe(0)
    expect(countUnderlagOnReplacedCopies).not.toHaveBeenCalled()
  })
})
