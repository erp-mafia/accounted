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
  listConsents,
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
      customerInvoicePdfs: { scanned: 2, linked: 1, invoiceOnly: 1, skipped: 0, locked: 0, failed: 0, refused: 0 },
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
      result: {
        scanned: 4,
        locked: 2,
        lockedPeriods: ['2024'],
        customerInvoicePdfs: { scanned: 2, linked: 1, invoiceOnly: 1 },
      },
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

  it('records the connection the slice read and the tab as its driver (crm#1581)', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue(realSlice)
    const { ctx, set } = contextWithSettings()

    await handler(request(false), ctx)

    expect(set).toHaveBeenCalledWith(
      'document_import_run',
      expect.objectContaining({ driver: 'browser', consentId: 'consent-1' }),
    )
  })
})

describe('POST /import-documents while the server carries the run on (crm#1581)', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const kept = (overrides: Record<string, unknown> = {}) => ({
    provider: 'fortnox',
    startedAt: minutesAgo(24 * 60),
    updatedAt: minutesAgo(1),
    complete: false,
    total: 17219,
    scanned: 7740,
    linked: 1962,
    skipped: 2,
    unmatched: 5776,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: 'file-7740',
    needsReconnect: false,
    driver: 'server',
    consentId: 'consent-1',
    ...overrides,
  })

  function contextWithRun(stored: unknown) {
    const ctx = buildContext()
    const set = vi.fn().mockResolvedValue(undefined)
    ;(ctx as unknown as { settings: unknown }).settings = { get: vi.fn().mockResolvedValue(stored), set, clear: vi.fn() }
    return { ctx, set }
  }

  /** The company's latest completed ledger import, as the route's read answers it. */
  function withLedgerImport(ctx: ExtensionContext, row: { imported_at: string | null; created_at: string }) {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: row })
    ;(supabase as unknown as { auth: unknown }).auth = (ctx.supabase as unknown as { auth: unknown }).auth
    ;(ctx as unknown as { supabase: unknown }).supabase = supabase
  }

  /** A first slice of a run started from the top. */
  const freshSlice = {
    provider: 'fortnox', scanned: 300, linked: 90, skipped: 0, unmatched: 210, failed: 0, locked: 0,
    lockedPeriods: [], dryRun: false, unmatchedSamples: [], total: 17219, partial: true,
    nextCursor: 'file-300', unreachableSources: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    // The run's connection, accepted a day before the run started.
    ;(listConsents as Mock).mockResolvedValue([
      { id: 'consent-1', provider: 'fortnox', status: 1, createdAt: minutesAgo(48 * 60) },
    ])
  })

  it('tells the tab the run goes on without it instead of starting a second chain', async () => {
    const { ctx, set } = contextWithRun(kept())

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await handler(request(false), ctx))

    expect(status).toBe(409)
    expect(body.error.code).toBe('PROVIDER_IMPORT_DOCUMENTS_RUNNING_ON_SERVER')
    expect(importProviderDocuments).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('does the same while a worker holds the run, whoever answered its latest slice', async () => {
    const lease = { owner: 'worker-1', until: new Date(Date.now() + 5 * 60_000).toISOString() }
    const { ctx } = contextWithRun(kept({ driver: 'browser', updatedAt: minutesAgo(30), lease }))

    expect((await handler(request(false), ctx)).status).toBe(409)
    expect(importProviderDocuments).not.toHaveBeenCalled()
  })

  it('lets a request on a newer connection start a run of its own, which the server lets go of', async () => {
    // Fortnox was reconnected: the run's connection is gone, a newer one is accepted.
    ;(listConsents as Mock).mockResolvedValue([
      { id: 'consent-2', provider: 'fortnox', status: 1, createdAt: minutesAgo(60) },
    ])
    ;(importProviderDocuments as Mock).mockResolvedValue(freshSlice)
    const lease = { owner: 'worker-1', until: new Date(Date.now() + 5 * 60_000).toISOString() }
    const stored = kept({ lease })
    const { ctx, set } = contextWithRun(stored)

    const response = await handler(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-documents', {
        method: 'POST',
        body: { consentId: 'consent-2', dryRun: false },
      }),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(importProviderDocuments).toHaveBeenCalledWith(expect.objectContaining({ consentId: 'consent-2', cursor: null }))
    // The new run replaces the summary, and with it the worker's hold.
    const summary = set.mock.calls[0][1]
    expect(summary).toMatchObject({ scanned: 300, nextCursor: 'file-300', driver: 'browser', consentId: 'consent-2' })
    expect(summary.startedAt).not.toBe(stored.startedAt)
    expect(summary).not.toHaveProperty('lease')
  })

  it('lets a request after a newer ledger import start a run of its own', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue(freshSlice)
    const stored = kept()
    const { ctx, set } = contextWithRun(stored)
    withLedgerImport(ctx, { imported_at: minutesAgo(60), created_at: minutesAgo(61) })

    expect((await handler(request(false), ctx)).status).toBe(200)
    expect(set.mock.calls[0][1].startedAt).not.toBe(stored.startedAt)
  })

  it('keeps the hold when the facts cannot be read', async () => {
    ;(listConsents as Mock).mockRejectedValue(new Error('provider_consents unavailable'))
    const { ctx } = contextWithRun(kept())

    expect((await handler(request(false), ctx)).status).toBe(409)
    expect(importProviderDocuments).not.toHaveBeenCalled()
  })

  it('still answers discovery, which writes nothing', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue({ ...kept(), dryRun: true, partial: false })
    const { ctx } = contextWithRun(kept())

    const response = await handler(request(true), ctx)

    expect(response.status).toBe(200)
    expect(importProviderDocuments).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  })

  it('lets the tab drive a run the server went quiet on', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue({ ...kept(), dryRun: false })
    const { ctx } = contextWithRun(kept({ updatedAt: minutesAgo(30) }))

    expect((await handler(request(false), ctx)).status).toBe(200)
    expect(importProviderDocuments).toHaveBeenCalledTimes(1)
  })

  it("hands a run the server went quiet on back to the run's own tab at the server's point", async () => {
    // The server drove the run on to file-7740. The tab still holds file-2740
    // from before it slept, and the run id its answers carried.
    const stored = kept({ updatedAt: minutesAgo(30) })
    ;(importProviderDocuments as Mock).mockResolvedValue({
      provider: 'fortnox', scanned: 200, linked: 60, skipped: 0, unmatched: 140, failed: 0, locked: 0,
      lockedPeriods: [], dryRun: false, unmatchedSamples: [], total: 17219, partial: true,
      nextCursor: 'file-7940', unreachableSources: [],
    })
    const { ctx, set } = contextWithRun(stored)

    const response = await handler(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-documents', {
        method: 'POST',
        body: { consentId: 'consent-1', dryRun: false, cursor: 'file-2740', run: stored.startedAt },
      }),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(importProviderDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'file-2740', savedRun: expect.objectContaining({ nextCursor: 'file-7740' }) }),
    )
    expect(set).toHaveBeenCalledWith(
      'document_import_run',
      expect.objectContaining({ startedAt: stored.startedAt, scanned: 7940, nextCursor: 'file-7940', driver: 'browser' }),
    )
  })
})

describe('POST /import-documents continues from the point the saved run reached (crm#1581)', () => {
  // The customer's run: the server folded the slice that reached file-2740,
  // but the laptop slept before the tab got that answer.
  const saved = {
    provider: 'fortnox',
    startedAt: '2026-10-31T10:37:18Z',
    updatedAt: '2026-10-31T11:10:08Z',
    complete: false,
    total: 17219,
    scanned: 2740,
    linked: 762,
    skipped: 2,
    unmatched: 1976,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: 'file-2740',
    needsReconnect: false,
  }

  function contextWithRun() {
    const ctx = buildContext()
    const set = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(saved)
    ;(ctx as unknown as { settings: unknown }).settings = { get, set, clear: vi.fn() }
    return { ctx, set, get }
  }

  // The tab still holds the cursor before the lost answer and retries it,
  // with the run id its earlier answers carried.
  function retry(body: Record<string, unknown> = { cursor: 'file-2540', run: saved.startedAt }) {
    return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-documents', {
      method: 'POST',
      body: { consentId: 'consent-1', dryRun: false, ...body },
    })
  }

  const nextSlice = {
    provider: 'fortnox',
    scanned: 200,
    linked: 60,
    skipped: 0,
    unmatched: 140,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    dryRun: false,
    unmatchedSamples: [],
    total: 17219,
    partial: true,
    nextCursor: 'file-2940',
    unreachableSources: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    fortnoxOAuth.documentScopesApproved = false
  })

  it('runs the retried slice from the saved point, keeps counting the run and names it in the answer', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue(nextSlice)
    const { ctx, set } = contextWithRun()

    const { status, body } = await parseJsonResponse<{ result: { run: string } }>(await handler(retry(), ctx))

    expect(status).toBe(200)
    expect(importProviderDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'file-2540', savedRun: expect.objectContaining({ nextCursor: 'file-2740' }) }),
    )
    // On main this slice was refused as a repeat and nothing was stored again.
    expect(set).toHaveBeenCalledWith(
      'document_import_run',
      expect.objectContaining({ startedAt: '2026-10-31T10:37:18Z', scanned: 2940, linked: 822, nextCursor: 'file-2940' }),
    )
    expect(body.result.run).toBe('2026-10-31T10:37:18Z')
  })

  it('leaves a newer run alone when a tab still looping on an older run continues', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue({ ...nextSlice, nextCursor: 'file-9200' })
    const { ctx, set } = contextWithRun()

    const { body } = await parseJsonResponse<{ result: { run: string } }>(
      await handler(retry({ cursor: 'file-9000', run: '2026-10-30T08:00:00Z' }), ctx),
    )

    expect(importProviderDocuments).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'file-9000', savedRun: null }))
    expect(set).not.toHaveBeenCalled()
    expect(body.result.run).toBe('2026-10-30T08:00:00Z')
  })

  it('keeps the exact-cursor rule for a tab that sends no run id (loaded before this change)', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValue(nextSlice)
    const { ctx, set, get } = contextWithRun()

    await handler(retry({ cursor: 'file-2540' }), ctx)
    expect(importProviderDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'file-2540', savedRun: null }))
    expect(set).not.toHaveBeenCalled()

    // Its slice from exactly the saved point still joins, as on main.
    await handler(retry({ cursor: 'file-2740' }), ctx)
    expect(set).toHaveBeenCalledWith('document_import_run', expect.objectContaining({ scanned: 2940 }))
    expect(importProviderDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'file-2740', savedRun: null }))
    // Each slice reads the run twice: whether the server drives it, and the fold.
    expect(get).toHaveBeenCalledTimes(4)
  })

  it('marks the saved run for a reconnect even when the retried cursor is behind it', async () => {
    ;(importProviderDocuments as Mock).mockRejectedValue(
      new ProviderConnectionRefusedError('fortnox', 'PROVIDER_AUTH_EXPIRED', 401),
    )
    const { ctx, set } = contextWithRun()

    const response = await handler(retry(), ctx)

    expect(response.status).toBe(401)
    expect(set).toHaveBeenCalledWith(
      'document_import_run',
      expect.objectContaining({ needsReconnect: true, scanned: 2740, nextCursor: 'file-2740' }),
    )
  })

  it('never reads the saved run for discovery, does not continue it for a new run, and names the new run', async () => {
    ;(importProviderDocuments as Mock).mockResolvedValueOnce({ ...nextSlice, dryRun: true, partial: false, nextCursor: null })
    const { ctx, get } = contextWithRun()

    await handler(request(true), ctx)
    expect(get).not.toHaveBeenCalled()

    ;(importProviderDocuments as Mock).mockResolvedValueOnce(nextSlice)
    const { body } = await parseJsonResponse<{ result: { run: string } }>(await handler(request(false), ctx))
    // Whether the server drives the run, and the fold's own read; a new run does not continue it.
    expect(get).toHaveBeenCalledTimes(2)
    expect(importProviderDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, savedRun: null }))
    expect(body.result.run).not.toBe(saved.startedAt)
    expect(typeof body.result.run).toBe('string')
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

describe('POST /submit-token WINT error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  // What a user who types their WINT login now reads. Prod, 2026-11-19: a
  // login WINT refused for BankID read "Kontrollera integrationsuppgifterna
  // och försök igen", which no retry could satisfy.
  it('answers what is no WINT API key with what the key is and where to find it', async () => {
    ;(submitProviderToken as Mock).mockRejectedValue(
      new ProviderTokenInvalidError('WINT API key holds no UUID', 'api-key-invalid'),
    )

    const response = await submitTokenHandler(submitTokenRequest(), buildContext())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en?: string }
    }>(response)

    expect(status).toBe(422)
    expect(body.error.code).toBe('WINT_API_KEY_INVALID')
    expect(body.error.message).toContain('Inställningar > Integrationer')
    expect(body.error.message).toContain('Lösenordet')
    expect(body.error.message).toContain('SIE-fil')
    expect(body.error.message).not.toContain('avvisade autentiseringen')
    expect(body.error.message_en).toContain('Settings > Integrations')
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
