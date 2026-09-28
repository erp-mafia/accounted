import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
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

import { arcimMigrationExtension } from '../index'
import { listConsents } from '../lib/provider-client'
import { createServiceClient } from '@/lib/supabase/server'

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

  it('returns 401 without a user', async () => {
    const { supabase } = buildSupabase({ history: [], latestCompleted: null, user: null })

    const res = await handler(statusRequest(), buildCtx(supabase))

    expect(res.status).toBe(401)
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

  it('returns 401 without a user and never looks up consents', async () => {
    const { res, service } = await statusWith({ provider_consents: [attempt()] }, null)

    expect(res.status).toBe(401)
    expect(service.from).not.toHaveBeenCalled()
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
