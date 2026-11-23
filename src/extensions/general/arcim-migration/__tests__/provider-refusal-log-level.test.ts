import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { ProviderCallError } from '@/lib/providers/with-provider-call'

/**
 * A provider's refusal is the customer's own state at the provider (an API
 * module that is not activated, an expired grant, a missing licence, a closed
 * register), and /preview and /migrate answer it with a typed 4xx that says
 * what to do. Logged at error, those answers filled PostHog's error issues:
 * a Visma company without its API module and an expired Fortnox grant were
 * 17 "arcim preview failed" and "arcim migration failed" events in the 30
 * days to 2026-11-22. They are warnings; anything else stays an error.
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
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

vi.mock('../lib/sie-fetcher', () => ({
  providerSupportsSie: vi.fn().mockReturnValue(false),
  fetchProviderSieFiles: vi.fn(),
  getAllowedFiscalYears: vi.fn().mockReturnValue([]),
  FiscalYearSelectionError: class FiscalYearSelectionError extends Error {},
  MAX_SELECTED_FISCAL_YEARS: 6,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { executeMigration } from '../lib/migration-orchestrator'
import { getConsent, resolveConsent, fetchCompanyInfoDirect } from '../lib/provider-client'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

function route(method: string, path: string): RouteHandler {
  return (arcimMigrationExtension.apiRoutes ?? []).find((r) => r.method === method && r.path === path)!
    .handler as RouteHandler
}

const previewHandler = route('GET', '/preview')
const migrateHandler = route('POST', '/migrate')

/** What Visma answers a company whose API module is not activated (prod, 2026-11-18). */
function vismaModuleRefusal(): Error {
  const e = new Error('Visma API error: 403 Forbidden') as Error & { statusCode: number; body: string }
  e.statusCode = 403
  e.body =
    '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'
  return e
}

/** What resolveConsent throws for a Fortnox grant that has expired (prod, 2026-11-17). */
function fortnoxGrantExpired(): Error {
  return new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'Fortnox credential resolution failed (PROVIDER_AUTH_EXPIRED)')
}

type Log = { info: Mock; warn: Mock; error: Mock }

function buildCtx(): { ctx: ExtensionContext; log: Log } {
  const { supabase, mockResult } = createMockSupabase()
  mockResult({ count: 1 })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { ctx: { supabase, companyId: 'company-1', userId: 'user-1', log } as unknown as ExtensionContext, log }
}

/** The calls of one level that logged `message`. */
function logged(fn: Mock, message: string): unknown[][] {
  return fn.mock.calls.filter((call) => call[0] === message)
}

function previewRequest() {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/preview', {
    searchParams: { consentId: 'consent-1' },
  })
}

function migrateRequest(headers?: Record<string, string>) {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/migrate', {
    method: 'POST',
    body: { consentId: 'consent-1' },
    headers,
  })
}

describe('GET /preview: the log level of a failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
    ;(resolveConsent as Mock).mockResolvedValue({
      consent: { provider: 'visma' },
      accessToken: 'tok',
      providerCompanyId: null,
    })
  })

  it('a Visma company without its API module is a warning', async () => {
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(vismaModuleRefusal())
    const { ctx, log } = buildCtx()

    const res = await previewHandler(previewRequest(), ctx)

    expect(res.status).toBe(403)
    expect(logged(log.warn, 'arcim preview failed')).toHaveLength(1)
    expect(logged(log.error, 'arcim preview failed')).toHaveLength(0)
  })

  it('an expired Fortnox grant is a warning', async () => {
    ;(resolveConsent as Mock).mockRejectedValue(fortnoxGrantExpired())
    const { ctx, log } = buildCtx()

    const res = await previewHandler(previewRequest(), ctx)

    expect(res.status).toBe(401)
    expect(logged(log.warn, 'arcim preview failed')).toHaveLength(1)
    expect(logged(log.error, 'arcim preview failed')).toHaveLength(0)
  })

  it('anything else stays an error', async () => {
    ;(resolveConsent as Mock).mockRejectedValue(new Error('relation "provider_consents" does not exist'))
    const { ctx, log } = buildCtx()

    const res = await previewHandler(previewRequest(), ctx)

    expect(res.status).toBe(500)
    expect(logged(log.error, 'arcim preview failed')).toHaveLength(1)
    expect(logged(log.warn, 'arcim preview failed')).toHaveLength(0)
  })
})

describe('POST /migrate: the log level of a failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
  })

  it('a Visma company without its API module is a warning', async () => {
    ;(executeMigration as Mock).mockRejectedValue(vismaModuleRefusal())
    const { ctx, log } = buildCtx()

    const res = await migrateHandler(migrateRequest(), ctx)

    expect(res.status).toBe(403)
    expect(logged(log.warn, 'arcim migration failed')).toHaveLength(1)
    expect(logged(log.error, 'arcim migration failed')).toHaveLength(0)
  })

  it('a Visma company without its API module is a warning on the streamed run too', async () => {
    ;(executeMigration as Mock).mockRejectedValue(vismaModuleRefusal())
    const { ctx, log } = buildCtx()

    const res = await migrateHandler(migrateRequest({ accept: 'application/x-ndjson' }), ctx)
    const lines = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as { kind: string })

    expect(lines.at(-1)?.kind).toBe('error')
    expect(logged(log.warn, 'arcim migration failed')).toHaveLength(1)
    expect(logged(log.error, 'arcim migration failed')).toHaveLength(0)
  })

  it('anything else stays an error, streamed or not', async () => {
    ;(executeMigration as Mock).mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"))
    const json = buildCtx()
    await migrateHandler(migrateRequest(), json.ctx)
    expect(logged(json.log.error, 'arcim migration failed')).toHaveLength(1)
    expect(logged(json.log.warn, 'arcim migration failed')).toHaveLength(0)

    const streamed = buildCtx()
    const res = await migrateHandler(migrateRequest({ accept: 'application/x-ndjson' }), streamed.ctx)
    await res.text()
    expect(logged(streamed.log.error, 'arcim migration failed')).toHaveLength(1)
    expect(logged(streamed.log.warn, 'arcim migration failed')).toHaveLength(0)
  })
})
