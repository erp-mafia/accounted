import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * #2469: /migrate hands the orchestrator the fiscal years the completed SIE
 * imports cover, so the invoice steps decline paid invoices outside them
 * before the detail pass, and forwards the per-request finishing flag the
 * wizard sends when it drives one step per request.
 */

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn().mockResolvedValue({ salesInvoices: { total: 0, imported: 0, skipped: 0 } }),
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
  acceptConsent: vi.fn().mockResolvedValue(undefined),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
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

type ImportRow = { fiscal_year_start: string | null; fiscal_year_end: string | null }

function buildCtx(importedYears: ImportRow[]): ExtensionContext {
  const { supabase, mockResult } = createMockSupabase()
  // Same mock answers the guard's count query and the scope query.
  mockResult({ count: importedYears.length, data: importedYears })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
}

function migrateRequest(body: Record<string, unknown>) {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/migrate', {
    method: 'POST',
    body: { consentId: 'consent-1', ...body },
  })
}

function orchestratorOptions(): Record<string, unknown> {
  return (executeMigration as Mock).mock.calls[0][0] as Record<string, unknown>
}

describe('POST /migrate: fiscal-year scope and per-step finishing flag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
  })

  it('passes the span of the completed SIE imports when an invoice step runs', async () => {
    const res = await handler(
      migrateRequest({ importCompanyInfo: false, importCustomers: false, importSuppliers: false, importSalesInvoices: true, importSupplierInvoices: false }),
      buildCtx([
        { fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' },
        { fiscal_year_start: '2025-01-01', fiscal_year_end: '2025-12-31' },
      ]),
    )

    expect(res.status).toBe(200)
    expect(orchestratorOptions().fiscalYearScope).toEqual({ start: '2025-01-01', end: '2026-12-31' })
  })

  it('fails the request instead of importing the whole register when the fiscal-year read errors', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    // Guard's count query succeeds; the scope query fails.
    enqueueMany([
      { count: 1 },
      { data: null, error: { message: 'connection reset' } },
    ])
    ;(supabase as unknown as { auth: { getUser: Mock } }).auth.getUser
      .mockResolvedValue({ data: { user: { id: 'user-1' } } })
    const ctx = { supabase, companyId: 'company-1' } as unknown as ExtensionContext

    const res = await handler(migrateRequest({ importSalesInvoices: true }), ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.error.code).toBe('PROVIDER_MIGRATE_FAILED')
    expect(executeMigration).not.toHaveBeenCalled()
  })

  it('passes no scope when the request runs no invoice step', async () => {
    await handler(
      migrateRequest({ importCompanyInfo: false, importCustomers: true, importSuppliers: false, importSalesInvoices: false, importSupplierInvoices: false }),
      buildCtx([{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]),
    )

    expect(orchestratorOptions().fiscalYearScope).toBeNull()
  })

  it('forwards grantProven only when the client asserts it', async () => {
    const imported = [{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]
    await handler(
      migrateRequest({ importSuppliers: true, grantProven: true }),
      buildCtx(imported),
    )
    expect(orchestratorOptions().grantProven).toBe(true)

    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
    await handler(migrateRequest({ importSuppliers: true, grantProven: 'yes' }), buildCtx(imported))
    expect(orchestratorOptions().grantProven).toBe(false)
  })

  it('forwards suggestParties and defaults it on for an older client', async () => {
    await handler(
      migrateRequest({ importSalesInvoices: true, suggestParties: false }),
      buildCtx([{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]),
    )
    expect(orchestratorOptions().suggestParties).toBe(false)

    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
    await handler(
      migrateRequest({ importSalesInvoices: true }),
      buildCtx([{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]),
    )
    expect(orchestratorOptions().suggestParties).toBe(true)
  })
})
