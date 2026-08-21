import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createMockRequest, createMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('../lib/import-documents', () => {
  class FortnoxDocumentScopesRequiredError extends Error {
    readonly code = 'PROVIDER_DOCUMENT_SCOPES_REQUIRED'

    constructor() {
      super('Fortnox consent lacks archive/connectfile scope: reconnect required')
    }
  }

  return {
    FortnoxDocumentScopesRequiredError,
    importProviderDocuments: vi.fn(),
  }
})

const fortnoxOAuth = vi.hoisted(() => ({ documentScopesApproved: false }))

vi.mock('@/lib/providers/fortnox/oauth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/providers/fortnox/oauth')>()
  return {
    ...actual,
    get FORTNOX_DOCUMENT_SCOPES_APPROVED() {
      return fortnoxOAuth.documentScopesApproved
    },
  }
})

vi.mock('../lib/provider-client', () => {
  class ProviderTokenInvalidError extends Error {
    constructor(
      message: string,
      readonly kind: 'credentials' | 'company-not-found' = 'credentials',
    ) {
      super(message)
    }
  }

  return {
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
    ProviderTokenInvalidError,
    ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
    ConsentNotFoundError: class ConsentNotFoundError extends Error {},
  }
})

import { arcimMigrationExtension } from '../index'
import {
  FortnoxDocumentScopesRequiredError,
  importProviderDocuments,
} from '../lib/import-documents'
import {
  ProviderTokenInvalidError,
  submitProviderToken,
} from '../lib/provider-client'

const route = (arcimMigrationExtension.apiRoutes ?? []).find(
  (candidate) =>
    candidate.method === 'POST' && candidate.path === '/import-documents',
)!

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = route.handler as RouteHandler
const submitTokenRoute = (arcimMigrationExtension.apiRoutes ?? []).find(
  (candidate) => candidate.method === 'POST' && candidate.path === '/submit-token',
)!
const submitTokenHandler = submitTokenRoute.handler as RouteHandler

function buildContext(): ExtensionContext {
  const { supabase } = createMockSupabase()
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
}

function request(dryRun: boolean) {
  return createMockRequest(
    'http://localhost/api/extensions/ext/arcim-migration/import-documents',
    {
      method: 'POST',
      body: { consentId: 'consent-1', dryRun },
    },
  )
}

function submitTokenRequest() {
  return createMockRequest(
    'http://localhost/api/extensions/ext/arcim-migration/submit-token',
    {
      method: 'POST',
      body: {
        consentId: 'consent-1',
        provider: 'bokio',
        apiToken: 'not-a-real-token',
        companyId: '9b408943-7a1e-47ac-85a7-ac52b2c210d3',
      },
    },
  )
}

describe('POST /import-documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    fortnoxOAuth.documentScopesApproved = false
  })

  it('passes dry-run discovery through without storing documents', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue({
      provider: 'fortnox',
      scanned: 4,
      linked: 3,
      skipped: 0,
      unmatched: 1,
      failed: 0,
      dryRun: true,
      unmatchedSamples: [],
    })

    const response = await handler(request(true), buildContext())
    const { status, body } = await parseJsonResponse<{
      success: boolean
      dryRun: boolean
      result: { scanned: number }
    }>(response)

    expect(status).toBe(200)
    expect(body).toMatchObject({ success: true, dryRun: true, result: { scanned: 4 } })
    expect(importProviderDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        consentId: 'consent-1',
        dryRun: true,
      }),
    )
  })

  it('passes a non-negative integer cursor through and restarts from 0 for anything else', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue({
      provider: 'fortnox',
      scanned: 1,
      linked: 1,
      skipped: 0,
      unmatched: 0,
      failed: 0,
      dryRun: false,
      unmatchedSamples: [],
      total: 113,
      partial: true,
      nextCursor: 18,
    })

    const withCursor = createMockRequest(
      'http://localhost/api/extensions/ext/arcim-migration/import-documents',
      { method: 'POST', body: { consentId: 'consent-1', dryRun: false, cursor: 17 } },
    )
    const { status, body } = await parseJsonResponse<{
      result: { partial: boolean; nextCursor: number | null }
    }>(await handler(withCursor, buildContext()))

    expect(status).toBe(200)
    expect(body.result).toMatchObject({ partial: true, nextCursor: 18 })
    expect(importProviderDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentId: 'consent-1', dryRun: false, cursor: 17 }),
    )

    const garbage = createMockRequest(
      'http://localhost/api/extensions/ext/arcim-migration/import-documents',
      { method: 'POST', body: { consentId: 'consent-1', cursor: -3.5 } },
    )
    await handler(garbage, buildContext())
    expect(importProviderDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 0 }),
    )
  })

  it('asks the user to reconnect only once the connect request carries the scopes', async () => {
    fortnoxOAuth.documentScopesApproved = true
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new FortnoxDocumentScopesRequiredError(),
    )

    const response = await handler(request(false), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('PROVIDER_DOCUMENT_SCOPES_REQUIRED')
    expect(body.error.message).toContain('Koppla om Fortnox')
    expect(body.error.message_en).toContain('Reconnect Fortnox')
  })

  // Klura AB, 2026-08-20: the connect request does not ask Fortnox for Arkiv
  // and Koppla fil at all, so the reconnect advice sent the user around a loop
  // four times (and to buy the Fortnox Arkiv module) for nothing.
  it('says the permission is missing on our side while the scopes are unapproved', async () => {
    fortnoxOAuth.documentScopesApproved = false
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new FortnoxDocumentScopesRequiredError(),
    )

    const response = await handler(request(false), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE')
    expect(body.error.message).not.toContain('Koppla om Fortnox')
    expect(body.error.message).toContain('Att koppla om hjälper inte')
    expect(body.error.message_en).toContain('Reconnecting will not help')
  })
})

describe('POST /submit-token Bokio error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('reports a 401/403 authentication verdict as rejected integration details', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new ProviderTokenInvalidError('Bokio rejected the integration token (HTTP 403)'),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(422)
    expect(body.error.code).toBe('PROVIDER_TOKEN_INVALID')
    expect(body.error.message).toContain('avvisade autentiseringen')
    expect(body.error.message_en).toContain('rejected the authentication')
  })

  it('reports a Bokio 404 as a company-ID failure instead of rejected credentials', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new ProviderTokenInvalidError(
        'Bokio does not know that company id',
        'company-not-found',
      ),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(422)
    expect(body.error.code).toBe('BOKIO_COMPANY_NOT_FOUND')
    expect(body.error.message).toContain('företags-ID')
    expect(body.error.message_en).toContain('company ID')
  })

  it('keeps an unclassified provider/configuration failure generic', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new Error('Bokio company-information response is missing companyInformation'),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('PROVIDER_TOKEN_SUBMIT_FAILED')
    expect(body.error.message).toContain('kontrollera integrationsuppgifterna')
    expect(body.error.message_en).toContain('verify the integration details')
  })
})
