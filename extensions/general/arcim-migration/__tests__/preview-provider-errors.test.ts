import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Locks what GET /preview does with a company-info failure.
 *
 * fetchCompanyInfoDirect used to swallow every provider error and return null,
 * which made the handler's classify-and-rethrow unreachable code: a Visma
 * company whose api_standard module is off got a 200 preview with
 * companyInfo: null, connected happily, and only discovered the problem when
 * the migration came back empty. The remediation text ("Appar och tillägg")
 * existed the whole time and never reached anyone.
 *
 * The other half matters just as much: a transient provider failure must stay
 * soft. The preview is still useful without the company card, and turning a
 * hiccup into a hard error would block the connect step for no reason.
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
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

// Visma serves no SIE over the API, but keep the fetcher stubbed so no test
// here can reach a provider over the network.
vi.mock('../lib/sie-fetcher', () => ({
  providerSupportsSie: vi.fn().mockReturnValue(false),
  fetchProviderSieFiles: vi.fn(),
  getAllowedFiscalYears: vi.fn().mockReturnValue([]),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { getConsent, resolveConsent, fetchCompanyInfoDirect } from '../lib/provider-client'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

const previewHandler = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'GET' && r.path === '/preview',
)!.handler as RouteHandler

const VISMA_MODULE_BODY =
  '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'

function vismaError(statusCode: number, body?: string): Error {
  const e = new Error(`Visma API error: ${statusCode}`) as Error & {
    statusCode: number
    body?: string
  }
  e.statusCode = statusCode
  e.body = body
  return e
}

function buildCtx(): ExtensionContext {
  const { supabase, mockResult } = createMockSupabase()
  // The handler counts completed SIE imports at the end of the happy path.
  mockResult({ count: 0 })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
}

function previewRequest() {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/preview', {
    searchParams: { consentId: 'consent-1' },
  })
}

describe('GET /preview: company-info failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
    ;(resolveConsent as Mock).mockResolvedValue({
      consent: { provider: 'visma' },
      accessToken: 'tok',
      providerCompanyId: null,
    })
  })

  it('answers 403 PROVIDER_API_MODULE_INACTIVE with the remediation instead of a silent empty preview', async () => {
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(vismaError(403, VISMA_MODULE_BODY))

    const res = await previewHandler(previewRequest(), buildCtx())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)

    expect(status).toBe(403)
    expect(body.error.code).toBe('PROVIDER_API_MODULE_INACTIVE')
    expect(body.error.message).toContain('Appar och tillägg')
  })

  it('keeps a transient provider failure soft: the preview still answers 200', async () => {
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(vismaError(503))

    const res = await previewHandler(previewRequest(), buildCtx())
    const { status, body } = await parseJsonResponse<{ companyInfo: unknown }>(res)

    expect(status).toBe(200)
    expect(body.companyInfo).toBeNull()
  })
})
