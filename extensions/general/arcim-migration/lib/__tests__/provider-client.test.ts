import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockBlGet } = vi.hoisted(() => ({ mockBlGet: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}))

vi.mock('@/lib/providers/bjornlunden/oauth', () => ({
  refreshBjornLundenToken: vi.fn().mockResolvedValue({
    access_token: 'bl-app-token',
    token_type: 'Bearer',
    expires_in: 3600,
  }),
}))

// Keep the real BjornLundenApiError (instanceof checks in provider-client)
// but replace the client so the /details probe is controllable per test.
vi.mock('@/lib/providers/bjornlunden/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/bjornlunden/client')>()
  return {
    ...actual,
    // Must be a `function` (not an arrow) so `new BjornLundenClient()` works.
    BjornLundenClient: vi.fn().mockImplementation(function mockClient() {
      return { get: mockBlGet }
    }),
  }
})

import { createServiceClient } from '@/lib/supabase/server'
import { BjornLundenApiError } from '@/lib/providers/bjornlunden/client'
import {
  submitProviderToken,
  ProviderTokenInvalidError,
  ConsentNotFoundError,
} from '../provider-client'

describe('submitProviderToken', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    vi.mocked(createServiceClient).mockReturnValue(mock.supabase as never)
  })

  const tablesTouched = () => vi.mocked(mock.supabase.from).mock.calls.map((c) => c[0])

  // ── Consent ownership (IDOR guard) ────────────────────────────────

  it('throws ConsentNotFoundError and writes NOTHING when the consent belongs to another company', async () => {
    // Ownership check finds no row for (consentId, ownerCompanyId): the same
    // result whether the consent does not exist or belongs to another tenant.
    mock.enqueue({ data: [] })

    await expect(
      submitProviderToken('consent-other-tenant', 'bokio', 'tok', 'bokio-guid', 'company-A'),
    ).rejects.toBeInstanceOf(ConsentNotFoundError)

    // Only the ownership read happened: no token upsert, no consent update.
    expect(tablesTouched()).toEqual(['provider_consents'])
  })

  it('stores tokens when the consent belongs to the caller company', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
    mock.enqueue({ data: null }) // token upsert

    const result = await submitProviderToken('consent-1', 'bokio', 'tok', 'bokio-guid', 'company-A')

    expect(result).toEqual({ success: true, consentId: 'consent-1' })
    expect(tablesTouched()).toEqual(['provider_consents', 'provider_consent_tokens'])
  })

  // ── BL /details probe error classification ────────────────────────

  it('does NOT map a 429 from the BL probe to ProviderTokenInvalidError', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
    mockBlGet.mockRejectedValueOnce(new BjornLundenApiError('Björn Lunden API error: 429', 429))

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bjornlunden',
      'client_credentials',
      'user-key-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BjornLundenApiError)
    expect(err).not.toBeInstanceOf(ProviderTokenInvalidError)
    // The transient failure must not store the unverified key either.
    expect(tablesTouched()).not.toContain('provider_consent_tokens')
  })

  it('does NOT map gateway-style 5xx (503) from the BL probe to ProviderTokenInvalidError', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBlGet.mockRejectedValueOnce(new BjornLundenApiError('Björn Lunden API error: 503', 503))

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bjornlunden',
      'client_credentials',
      'user-key-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BjornLundenApiError)
    expect(err).not.toBeInstanceOf(ProviderTokenInvalidError)
  })

  it('maps 500 from the BL probe to invalid credentials (sandbox-verified bad-key signal) and disables probe retries', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBlGet.mockRejectedValueOnce(new BjornLundenApiError('Björn Lunden API error: 500', 500))

    await expect(
      submitProviderToken('consent-1', 'bjornlunden', 'client_credentials', 'user-key-guid', 'company-A'),
    ).rejects.toBeInstanceOf(ProviderTokenInvalidError)

    // The probe must fail fast: a typo'd key answers 500, which the client's
    // retry policy treats as retryable: retry is disabled per call.
    expect(mockBlGet).toHaveBeenCalledTimes(1)
    expect(mockBlGet).toHaveBeenCalledWith('bl-app-token', 'user-key-guid', '/details', {
      retry: false,
    })
  })

  it('maps 404 from the BL probe to invalid credentials', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBlGet.mockRejectedValueOnce(new BjornLundenApiError('Björn Lunden API error: 404', 404))

    await expect(
      submitProviderToken('consent-1', 'bjornlunden', 'client_credentials', 'user-key-guid', 'company-A'),
    ).rejects.toBeInstanceOf(ProviderTokenInvalidError)
  })

  it('stores BL tokens (and labels the consent) when the probe succeeds', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
    mock.enqueue({ data: null }) // consent company_name update
    mock.enqueue({ data: null }) // token upsert
    mockBlGet.mockResolvedValueOnce({ name: 'Testbolaget AB' })

    const result = await submitProviderToken(
      'consent-1',
      'bjornlunden',
      'client_credentials',
      'user-key-guid',
      'company-A',
    )

    expect(result).toEqual({ success: true, consentId: 'consent-1' })
    expect(tablesTouched()).toEqual([
      'provider_consents',
      'provider_consents',
      'provider_consent_tokens',
    ])
  })
})
