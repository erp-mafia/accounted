import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Guards the server-side "SIE import required first" rule on the entity-migration
 * route (POST /migrate).
 *
 * Provider API import only ever writes subledger entities (customers, suppliers,
 * invoices): it never posts to the general ledger. The GL (kontoplan, ingående
 * balanser, verifikationer) arrives via SIE. Importing entities without the
 * SIE-derived ledger leaves an incomplete bokföring under BFL, so the route MUST
 * refuse to run for EVERY provider until a completed SIE import exists for the
 * company. Fortnox used to be exempt (it pulls SIE itself via API), but the
 * wizard lets the user uncheck "Bokföringsdata (SIE)" while keeping entities
 * checked (#2000), so the exemption is gone. The rule is "must exist", not "must
 * be part of this run": an entities-only re-run after a full migration passes.
 *
 * Previously this was only an advisory banner + step-gating in the React wizard,
 * which a direct API call or a stale client could bypass. This test locks the
 * enforcement at the authoritative seam: the route handler.
 */

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn().mockResolvedValue({ customers: { total: 0, imported: 0, skipped: 0 } }),
}))

// index.ts imports many helpers from provider-client at module load; stub the
// whole module and give getConsent/acceptConsent controllable behaviour.
vi.mock('../lib/provider-client', () => ({
  createConsent: vi.fn(),
  getConsent: vi.fn(),
  listConsents: vi.fn(),
  generateOtc: vi.fn(),
  consumeOAuthState: vi.fn(),
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn().mockResolvedValue(undefined),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
  // Real classes: index.ts branches on `instanceof` in the catch blocks.
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

import { arcimMigrationExtension } from '../index'
import { executeMigration } from '../lib/migration-orchestrator'
import { getConsent } from '../lib/provider-client'

const migrateRoute = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/migrate',
)!

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = migrateRoute.handler as RouteHandler

function buildCtx(count: number | null): ExtensionContext {
  const { supabase, mockResult } = createMockSupabase()
  // The guard awaits `from('sie_imports').select(..,{count,head}).eq().eq()`.
  mockResult({ count })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
}

function migrateRequest(body: Record<string, unknown> = { consentId: 'consent-1' }) {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/migrate', {
    method: 'POST',
    body,
  })
}

type GuardErrorBody = { error: { code: string; message: string; message_en?: string } }

describe('POST /migrate: SIE-import-required guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when there is no authenticated user', async () => {
    const ctx = buildCtx(0)
    ;(ctx.supabase as unknown as { auth: { getUser: Mock } }).auth.getUser
      .mockResolvedValue({ data: { user: null } })

    const res = await handler(migrateRequest(), ctx)

    expect(res.status).toBe(401)
    expect(getConsent).not.toHaveBeenCalled()
    expect(executeMigration).not.toHaveBeenCalled()
  })

  it('returns 400 when consentId is missing', async () => {
    const res = await handler(migrateRequest({}), buildCtx(1))

    expect(res.status).toBe(400)
    expect(getConsent).not.toHaveBeenCalled()
    expect(executeMigration).not.toHaveBeenCalled()
  })

  it('blocks a non-Fortnox provider when no completed SIE import exists', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })

    const res = await handler(migrateRequest(), buildCtx(0))
    const { status, body } = await parseJsonResponse<GuardErrorBody>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('PROVIDER_SIE_IMPORT_REQUIRED')
    // Visma has no SIE-over-API: the static registry text ("ladda upp en
    // SIE-fil") is the right instruction and must stay.
    expect(body.error.message).toMatch(/ladda upp en SIE-fil/i)
    expect(executeMigration).not.toHaveBeenCalled()
  })

  it('allows a non-Fortnox provider once a completed SIE import exists', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })

    const res = await handler(migrateRequest(), buildCtx(1))

    expect(res.status).toBe(200)
    expect(executeMigration).toHaveBeenCalledTimes(1)
  })

  it('blocks Fortnox when no completed SIE import exists (SIE step unchecked in the wizard)', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })

    const res = await handler(migrateRequest(), buildCtx(0))
    const { status, body } = await parseJsonResponse<GuardErrorBody>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('PROVIDER_SIE_IMPORT_REQUIRED')
    expect(executeMigration).not.toHaveBeenCalled()
  })

  it('tells SIE-over-API providers to tick the wizard checkbox, not to upload a file', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })

    const res = await handler(migrateRequest(), buildCtx(0))
    const { body } = await parseJsonResponse<GuardErrorBody>(res)

    expect(body.error.message).toContain('Bokföringsdata (SIE)')
    expect(body.error.message).not.toMatch(/ladda upp/i)
    expect(body.error.message_en).toContain('Bokföringsdata (SIE)')
    expect(body.error.message_en).not.toMatch(/upload/i)
  })

  it('allows Fortnox once a completed SIE import exists (entities-only re-run)', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })

    const res = await handler(migrateRequest(), buildCtx(1))

    expect(res.status).toBe(200)
    expect(executeMigration).toHaveBeenCalledTimes(1)
  })
})
