import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createMockRequest, createMockSupabase, parseJsonResponse } from '@/tests/helpers'
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

import { arcimMigrationExtension } from '../index'
import {
  FortnoxDocumentScopesRequiredError,
  importProviderDocuments,
} from '../lib/import-documents'

const route = (arcimMigrationExtension.apiRoutes ?? []).find(
  (candidate) =>
    candidate.method === 'POST' && candidate.path === '/import-documents',
)!

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = route.handler as RouteHandler

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

describe('POST /import-documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('returns an actionable 403 when Fortnox lacks archive/connectfile scopes', async () => {
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
})
