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
 * refuse to run for non-Fortnox providers until a completed SIE import exists.
 * Fortnox is exempt because it pulls SIE itself via API.
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
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn().mockResolvedValue(undefined),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
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

function migrateRequest() {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/migrate', {
    method: 'POST',
    body: { consentId: 'consent-1' },
  })
}

describe('POST /migrate: SIE-import-required guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks a non-Fortnox provider when no completed SIE import exists', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })

    const res = await handler(migrateRequest(), buildCtx(0))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('PROVIDER_SIE_IMPORT_REQUIRED')
    expect(executeMigration).not.toHaveBeenCalled()
  })

  it('allows a non-Fortnox provider once a completed SIE import exists', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })

    const res = await handler(migrateRequest(), buildCtx(1))

    expect(res.status).toBe(200)
    expect(executeMigration).toHaveBeenCalledTimes(1)
  })

  it('exempts Fortnox: entity import runs even with no SIE import (SIE comes via API)', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })

    const res = await handler(migrateRequest(), buildCtx(0))

    expect(res.status).toBe(200)
    expect(executeMigration).toHaveBeenCalledTimes(1)
  })
})
