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

import { arcimMigrationExtension } from '../index'
import { listConsents } from '../lib/provider-client'

const route = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'GET' && r.path === '/status',
)!
type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = route.handler as RouteHandler

type Row = Record<string, unknown>
type StatusBody = { sieImports: Row[]; hasCompletedSieImport: boolean; latestCompletedSieImport: Row | null }
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

describe('GET /status: completed SIE import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(listConsents as Mock).mockResolvedValue([])
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
