import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * POST /migrate runs company information and the asset register only. The
 * customer, supplier and invoice registers go through the background import
 * job, which reads every record in full: this route read Fortnox's own
 * records for at most 90 seconds and saved the rest from the short list
 * (crm#1436), so it refuses them. It still forwards the per-request flags the
 * wizard sends when it drives one step per request (#2469).
 */

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn().mockResolvedValue({ assets: { total: 0, imported: 0, skipped: 0 } }),
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
  return { supabase, companyId: 'company-1', userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
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

describe('POST /migrate: no registers, and the per-step flags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })
  })

  it.each(['importCustomers', 'importSuppliers', 'importSalesInvoices', 'importSupplierInvoices'])(
    'refuses %s: the registers go through the background import',
    async (flag) => {
      const res = await handler(migrateRequest({ [flag]: true }), buildCtx([{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
      expect(status).toBe(409)
      expect(body.error.code).toBe('PROVIDER_REGISTERS_VIA_JOB')
      expect(executeMigration).not.toHaveBeenCalled()
    },
  )

  it('runs the asset register with every register off, whatever an older client omits', async () => {
    const res = await handler(migrateRequest({ importAssets: true }), buildCtx([{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]))
    expect(res.status).toBe(200)
    expect(orchestratorOptions()).toMatchObject({
      importAssets: true, importCustomers: false, importSuppliers: false, importSalesInvoices: false,
      importSupplierInvoices: false, fiscalYearScope: null,
    })
  })

  it('forwards grantProven only when the client asserts it', async () => {
    const imported = [{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]
    await handler(migrateRequest({ importAssets: true, grantProven: true }), buildCtx(imported))
    expect(orchestratorOptions().grantProven).toBe(true)

    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })
    await handler(migrateRequest({ importAssets: true, grantProven: 'yes' }), buildCtx(imported))
    expect(orchestratorOptions().grantProven).toBe(false)
  })

  it('forwards suggestParties and defaults it on for an older client', async () => {
    const imported = [{ fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }]
    await handler(migrateRequest({ importAssets: true, suggestParties: false }), buildCtx(imported))
    expect(orchestratorOptions().suggestParties).toBe(false)

    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'fortnox' })
    await handler(migrateRequest({ importAssets: true }), buildCtx(imported))
    expect(orchestratorOptions().suggestParties).toBe(true)
  })
})
