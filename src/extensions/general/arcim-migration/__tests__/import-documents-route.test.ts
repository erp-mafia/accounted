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

  class ProviderConnectionRefusedError extends Error {
    constructor(
      readonly provider: string,
      readonly code: 'PROVIDER_AUTH_EXPIRED' | 'PROVIDER_RESOURCE_FORBIDDEN',
      readonly providerStatus: number,
    ) {
      super(`${provider} refused the connection (${providerStatus}): reconnect required`)
    }
  }

  return {
    FortnoxDocumentScopesRequiredError,
    ProviderConnectionRefusedError,
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
      readonly kind:
        | 'credentials'
        | 'company-not-found'
        | 'integration-not-activated'
        | 'company-key-not-found'
        | 'plan-no-api' = 'credentials',
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
  ProviderConnectionRefusedError,
  importProviderDocuments,
} from '../lib/import-documents'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
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
  return { supabase, companyId: 'company-1', userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
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
      locked: 2,
      lockedPeriods: ['2024'],
      dryRun: true,
      unmatchedSamples: [],
    })

    const response = await handler(request(true), buildContext())
    const { status, body } = await parseJsonResponse<{
      success: boolean
      dryRun: boolean
      result: { scanned: number; locked: number; lockedPeriods: string[] }
    }>(response)

    expect(status).toBe(200)
    // The locked-year count reaches the wizard, which names the years to reopen (crm#251).
    expect(body).toMatchObject({
      success: true,
      dryRun: true,
      result: { scanned: 4, locked: 2, lockedPeriods: ['2024'] },
    })
    expect(importProviderDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        consentId: 'consent-1',
        dryRun: true,
      }),
    )
  })

  it('passes a non-empty string cursor through and restarts from the top for anything else', async () => {
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
      nextCursor: 'file-18',
    })

    const withCursor = createMockRequest(
      'http://localhost/api/extensions/ext/arcim-migration/import-documents',
      { method: 'POST', body: { consentId: 'consent-1', dryRun: false, cursor: 'file-17' } },
    )
    const { status, body } = await parseJsonResponse<{
      result: { partial: boolean; nextCursor: string | null }
    }>(await handler(withCursor, buildContext()))

    expect(status).toBe(200)
    expect(body.result).toMatchObject({ partial: true, nextCursor: 'file-18' })
    expect(importProviderDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentId: 'consent-1', dryRun: false, cursor: 'file-17' }),
    )

    const garbage = createMockRequest(
      'http://localhost/api/extensions/ext/arcim-migration/import-documents',
      { method: 'POST', body: { consentId: 'consent-1', cursor: 17 } },
    )
    await handler(garbage, buildContext())
    expect(importProviderDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: null }),
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

  // Support case 2026-08-20: the connect request does not ask Fortnox for Arkiv
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

describe('POST /import-documents keeps the run outcome (crm#1410)', () => {
  const realSlice = {
    provider: 'fortnox',
    scanned: 40,
    linked: 39,
    skipped: 0,
    unmatched: 1,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    dryRun: false,
    unmatchedSamples: [],
    total: 3003,
    partial: true,
    nextCursor: 'file-40',
    unreachableSources: [],
  }

  function contextWithSettings(set = vi.fn().mockResolvedValue(undefined)) {
    const ctx = buildContext()
    ;(ctx as unknown as { settings: unknown }).settings = {
      get: vi.fn().mockResolvedValue(null),
      set,
      clear: vi.fn(),
    }
    return { ctx, set }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('stores the summary of a real slice for the page to show later', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue(realSlice)
    const { ctx, set } = contextWithSettings()

    const response = await handler(request(false), ctx)

    expect(response.status).toBe(200)
    expect(set).toHaveBeenCalledWith(
      'document_import_run',
      expect.objectContaining({ provider: 'fortnox', scanned: 40, linked: 39, total: 3003, complete: false, nextCursor: 'file-40' }),
    )
  })

  it('stores nothing for discovery', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue({ ...realSlice, dryRun: true })
    const { ctx, set } = contextWithSettings()

    await handler(request(true), ctx)

    expect(set).not.toHaveBeenCalled()
  })

  it('answers the slice even when the summary cannot be stored', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue(realSlice)
    const { ctx } = contextWithSettings(vi.fn().mockRejectedValue(new Error('extension_data set failed')))

    const { status, body } = await parseJsonResponse<{ success: boolean; result: { linked: number } }>(
      await handler(request(false), ctx),
    )

    expect(status).toBe(200)
    expect(body).toMatchObject({ success: true, result: { linked: 39 } })
  })
})

describe('POST /import-documents stops once on a refused connection (B11)', () => {
  const running = {
    provider: 'fortnox',
    startedAt: '2026-10-22T17:30:00Z',
    updatedAt: '2026-10-22T17:49:00Z',
    complete: false,
    total: 4610,
    scanned: 1200,
    linked: 1190,
    skipped: 5,
    unmatched: 5,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: 'file-1200',
  }

  function contextWithRun(stored: unknown = running) {
    const ctx = buildContext()
    const set = vi.fn().mockResolvedValue(undefined)
    ;(ctx as unknown as { settings: unknown }).settings = { get: vi.fn().mockResolvedValue(stored), set, clear: vi.fn() }
    return { ctx, set, log: ctx.log as unknown as { warn: Mock; error: Mock } }
  }

  function slice(cursor: string | null, dryRun = false) {
    return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-documents', {
      method: 'POST',
      body: cursor ? { consentId: 'consent-1', dryRun, cursor } : { consentId: 'consent-1', dryRun },
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    fortnoxOAuth.documentScopesApproved = false
  })

  it('answers a token Fortnox refuses after a refresh with a reconnect, warns once and marks the run', async () => {
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new ProviderConnectionRefusedError('fortnox', 'PROVIDER_AUTH_EXPIRED', 401),
    )
    const { ctx, set, log } = contextWithRun()

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await handler(slice('file-1200'), ctx),
    )

    // A 4xx: the page offers the reconnect instead of retrying the slice.
    expect(status).toBe(401)
    expect(body.error.code).toBe('PROVIDER_AUTH_EXPIRED')
    expect(set).toHaveBeenCalledWith(
      'document_import_run',
      expect.objectContaining({ needsReconnect: true, scanned: 1200, nextCursor: 'file-1200' }),
    )
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('answers a grant the refresh was refused the same way, also before the first slice', async () => {
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'refresh refused', { providerCode: 'invalid_grant' }),
    )
    const { ctx, set } = contextWithRun()

    const response = await handler(slice(null), ctx)

    expect(response.status).toBe(401)
    expect(set).toHaveBeenCalledWith(
      'document_import_run',
      expect.objectContaining({ provider: 'fortnox', scanned: 0, complete: false, needsReconnect: true }),
    )
  })

  it('names a Bokio token without the right as a refused permission', async () => {
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new ProviderConnectionRefusedError('bokio', 'PROVIDER_RESOURCE_FORBIDDEN', 403),
    )
    const { ctx, set } = contextWithRun(null)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await handler(slice(null), ctx))

    expect(status).toBe(403)
    expect(body.error.code).toBe('PROVIDER_RESOURCE_FORBIDDEN')
    expect(set).toHaveBeenCalledWith('document_import_run', expect.objectContaining({ provider: 'bokio', needsReconnect: true }))
  })

  it('marks the run when the files need the Fortnox scopes a reconnect grants', async () => {
    fortnoxOAuth.documentScopesApproved = true
    ;(importProviderDocuments as Mock).mockRejectedValue(new FortnoxDocumentScopesRequiredError())
    const { ctx, set, log } = contextWithRun()

    const response = await handler(slice('file-1200'), ctx)

    expect(response.status).toBe(403)
    expect(set).toHaveBeenCalledWith('document_import_run', expect.objectContaining({ needsReconnect: true }))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('keeps discovery out of the run summary', async () => {
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new ProviderConnectionRefusedError('fortnox', 'PROVIDER_AUTH_EXPIRED', 401),
    )
    const { ctx, set } = contextWithRun()

    const response = await handler(slice(null, true), ctx)

    expect(response.status).toBe(401)
    expect(set).not.toHaveBeenCalled()
  })

  it('answers a refresh the provider failed transiently with a 5xx the page retries, the run untouched', async () => {
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new ProviderCallError('PROVIDER_UPSTREAM_ERROR', 'fortnox', 'refresh 503', { status: 503 }),
    )
    const { ctx, set } = contextWithRun()

    const response = await handler(slice('file-1200'), ctx)

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(set).not.toHaveBeenCalled()
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

  // 2026-10-27: a company id without a GUID drew a Bokio 400 that read
  // "Kunde inte kontrollera ... Försök igen", five times for one user.
  it('reports a company ID without a GUID as a format problem that says where the GUID is', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new ProviderTokenInvalidError('Bokio company id holds no GUID', 'company-id-invalid'),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(422)
    expect(body.error.code).toBe('BOKIO_COMPANY_ID_INVALID')
    expect(body.error.message).toContain('webbadressen')
    expect(body.error.message).not.toContain('Försök igen')
    expect(body.error.message_en).toContain('address bar')
  })

  it('reports a Bokio plan without API access as a plan problem, not rejected credentials', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new ProviderTokenInvalidError('Bokio plan has no API access (HTTP 403)', 'plan-no-api'),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(422)
    expect(body.error.code).toBe('BOKIO_PLAN_NO_API')
    expect(body.error.message).toContain('Plus, Premium och Business')
    expect(body.error.message).not.toContain('avvisade autentiseringen')
    expect(body.error.message_en).toContain('Plus, Premium and Business')
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

describe('POST /submit-token Björn Lundén error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('reports a valid key whose company never activated the integration as an activation problem, not bad credentials', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new ProviderTokenInvalidError(
        'Björn Lundén: the company behind this User-Key has not activated the integration',
        'integration-not-activated',
      ),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(422)
    expect(body.error.code).toBe('BL_INTEGRATION_NOT_ACTIVATED')
    expect(body.error.message).toContain('Aktivera integrationen')
    expect(body.error.message).not.toContain('avvisade autentiseringen')
    expect(body.error.message_en).toContain('Activate the integration')
  })

  it('reports an unknown User-Key as a key problem with the place to copy it from', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new ProviderTokenInvalidError(
        'Björn Lundén found no company for the key (HTTP 500)',
        'company-key-not-found',
      ),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(422)
    expect(body.error.code).toBe('BL_COMPANY_KEY_NOT_FOUND')
    expect(body.error.message).toContain('hittade inget företag')
    expect(body.error.message_en).toContain('found no company')
  })
})

describe('POST /submit-token asks for the credentials the catalog names', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function credentialsRequest(body: Record<string, unknown>) {
    return createMockRequest(
      'http://localhost/api/extensions/ext/arcim-migration/submit-token',
      { method: 'POST', body: { consentId: 'consent-1', ...body } },
    )
  }

  it('connects Björn Lundén with the company key alone, on our client credentials', async () => {
    ;(submitProviderToken as Mock).mockResolvedValue({ success: true, consentId: 'consent-1' })

    const response = await submitTokenHandler(
      credentialsRequest({ provider: 'bjornlunden', apiToken: '', companyId: '1f0e2d3c-4b5a-4968-8776-655443322110' }),
      buildContext(),
    )

    expect(response.status).toBe(200)
    expect(submitProviderToken).toHaveBeenCalledWith(
      'consent-1',
      'bjornlunden',
      'client_credentials',
      '1f0e2d3c-4b5a-4968-8776-655443322110',
      'company-1',
    )
  })

  it('refuses Björn Lundén without the company key before calling BL', async () => {
    const response = await submitTokenHandler(credentialsRequest({ provider: 'bjornlunden' }), buildContext())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('PROVIDER_COMPANY_ID_REQUIRED')
    expect(submitProviderToken).not.toHaveBeenCalled()
  })

  it('refuses Bokio without its integration token', async () => {
    const response = await submitTokenHandler(
      credentialsRequest({ provider: 'bokio', companyId: '9b408943-7a1e-47ac-85a7-ac52b2c210d3' }),
      buildContext(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('PROVIDER_TOKEN_REQUIRED')
    expect(submitProviderToken).not.toHaveBeenCalled()
  })
})
