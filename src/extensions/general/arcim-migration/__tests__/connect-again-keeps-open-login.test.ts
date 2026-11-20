import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * POST /connect clicked again while the provider login of the previous click
 * is still open.
 *
 * It deleted every token-less pending consent and created a new one, and the
 * delete took the open window's state with it. On 2026-11-12 a customer
 * clicked connect at 17:09:49 and again at 17:11:30; at 17:11:45 the first
 * window came back from Fortnox with a licence refusal and was answered
 * "Ingen giltig migrationssession hittades" instead (the second window then
 * connected). The open window's state now moves onto the new attempt before
 * the old one is deleted, and the new row stays the record of the attempt
 * (findUnfinishedConnect reads it).
 */

const { svc } = vi.hoisted(() => ({ svc: { current: null as unknown } }))

vi.mock('../lib/migration-orchestrator', () => ({ executeMigration: vi.fn().mockResolvedValue({}) }))

vi.mock('../lib/provider-client', () => ({
  createConsent: vi.fn(),
  getConsent: vi.fn(),
  listConsents: vi.fn(),
  generateOtc: vi.fn(),
  consumeOAuthState: vi.fn(),
  peekOAuthState: vi.fn(),
  oauthStateRejectionReason: vi.fn(),
  moveOpenLogins: vi.fn(),
  consentHoldsTokens: vi.fn(),
  mintHandoff: vi.fn(),
  consumeHandoff: vi.fn(),
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

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => svc.current),
}))

vi.mock('@/lib/branding/resolve', () => ({ resolveBrandByHost: vi.fn().mockResolvedValue(null) }))

import { arcimMigrationExtension } from '../index'
import {
  createConsent,
  deleteConsent,
  generateOtc,
  getAuthUrl,
  listConsents,
  moveOpenLogins,
} from '../lib/provider-client'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const connectHandler = (arcimMigrationExtension.apiRoutes ?? [])
  .find((r) => r.method === 'POST' && r.path === '/connect')!.handler as RouteHandler

const APP_URL = 'https://app.example.test'

const pendingConsent = (id: string) => ({ id, name: 'gnubok-migration-user-1', provider: 'fortnox' as const, status: 0 as const })

const connect = () =>
  connectHandler(
    createMockRequest(`${APP_URL}/api/extensions/ext/arcim-migration/connect`, {
      method: 'POST',
      body: { provider: 'fortnox' },
    }),
    {
      companyId: 'company-1',
      userId: 'user-1',
      supabase: {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ExtensionContext,
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
  vi.stubEnv('FORTNOX_REDIRECT_URI', '')
  // No pending consent holds tokens: every one of them is a login not yet finished.
  svc.current = createTableMockSupabase({ provider_consent_tokens: { data: [] } }).supabase
  vi.mocked(generateOtc).mockResolvedValue({ code: 'state-2', consentId: 'consent-new', expiresAt: '' })
  vi.mocked(getAuthUrl).mockResolvedValue({ url: 'https://apps.fortnox.se/oauth-v1/auth?state=state-2' } as Awaited<ReturnType<typeof getAuthUrl>>)
  vi.mocked(createConsent).mockResolvedValue(pendingConsent('consent-new'))
  vi.mocked(moveOpenLogins).mockResolvedValue(1)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /connect clicked again', () => {
  it('moves the open login onto the new attempt before the old one is deleted', async () => {
    vi.mocked(listConsents).mockResolvedValue([pendingConsent('consent-open')])

    const body = await (await connect()).json()

    expect(createConsent).toHaveBeenCalledOnce()
    expect(moveOpenLogins).toHaveBeenCalledWith(['consent-open'], 'consent-new')
    expect(deleteConsent).toHaveBeenCalledWith('consent-open')
    // The move comes first: deleting a consent deletes its state rows.
    expect(vi.mocked(moveOpenLogins).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteConsent).mock.invocationCallOrder[0]!)
    // The new attempt is the one the wizard holds, with a state of its own.
    expect(generateOtc).toHaveBeenCalledWith('consent-new', 'user-1', APP_URL)
    expect(body).toMatchObject({ consentId: 'consent-new', authType: 'oauth' })
    expect(body.authUrl).toContain('state=state-2')
  })

  it('cleans up every earlier attempt, open or abandoned', async () => {
    vi.mocked(listConsents).mockResolvedValue([pendingConsent('consent-b'), pendingConsent('consent-a')])

    await connect()

    expect(moveOpenLogins).toHaveBeenCalledWith(['consent-b', 'consent-a'], 'consent-new')
    expect(vi.mocked(deleteConsent).mock.calls.map(([id]) => id)).toEqual(['consent-b', 'consent-a'])
  })

  it('still starts and cleans up when nothing could be moved', async () => {
    vi.mocked(listConsents).mockResolvedValue([pendingConsent('consent-abandoned')])
    vi.mocked(moveOpenLogins).mockResolvedValue(0)

    const body = await (await connect()).json()

    expect(deleteConsent).toHaveBeenCalledWith('consent-abandoned')
    expect(body).toMatchObject({ consentId: 'consent-new', authType: 'oauth' })
  })

  it('moves nothing on a first connect', async () => {
    vi.mocked(listConsents).mockResolvedValue([])

    const body = await (await connect()).json()

    expect(moveOpenLogins).not.toHaveBeenCalled()
    expect(deleteConsent).not.toHaveBeenCalled()
    expect(body.consentId).toBe('consent-new')
  })
})
