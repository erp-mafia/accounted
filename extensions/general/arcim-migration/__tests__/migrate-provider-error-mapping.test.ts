import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Locks the /migrate route's mapping of a doomed provider run to a structured
 * error response. When the orchestrator rethrows a connection-level failure
 * (here: Visma's "No access to module: api_standard"), the route must answer
 * with PROVIDER_API_MODULE_INACTIVE and its remediation, not a generic
 * PROVIDER_MIGRATE_FAILED or a misleading success envelope.
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

function buildCtx(): ExtensionContext {
  const { supabase, mockResult } = createMockSupabase()
  // The SIE guard awaits `from('sie_imports').select(..,{count,head}).eq().eq()`.
  mockResult({ count: 1 })
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

function vismaModuleError(): Error {
  const e = new Error('Visma API error: 403 Forbidden') as Error & {
    statusCode: number
    body: string
  }
  e.statusCode = 403
  e.body =
    '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'
  return e
}

describe('POST /migrate: provider error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers 403 PROVIDER_API_MODULE_INACTIVE when the orchestrator hits an inactive Visma API module', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
    ;(executeMigration as Mock).mockRejectedValue(vismaModuleError())

    const res = await handler(migrateRequest(), buildCtx())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)

    expect(status).toBe(403)
    expect(body.error.code).toBe('PROVIDER_API_MODULE_INACTIVE')
    expect(body.error.message).toContain('Appar och tillägg')
  })

  it('still returns success with stepErrors passed through for non-fatal partial failures', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
    ;(executeMigration as Mock).mockResolvedValue({
      customers: { total: 5, imported: 5, updated: 0, skipped: 0, skipReasons: {} },
      stepErrors: [
        {
          step: 'suppliers',
          code: 'PROVIDER_UPSTREAM_ERROR',
          message: 'Leverantören svarade med ett fel. Försök igen om en stund.',
        },
      ],
    })

    const res = await handler(migrateRequest(), buildCtx())
    const { status, body } = await parseJsonResponse<{
      success: boolean
      results: { stepErrors?: { step: string; code: string | null }[] }
    }>(res)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.results.stepErrors).toHaveLength(1)
    expect(body.results.stepErrors![0].step).toBe('suppliers')
  })
})
