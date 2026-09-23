import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockBlGet, mockBokioGetCompany, mockWintGet, mockLoginWint } = vi.hoisted(() => ({
  mockBlGet: vi.fn(),
  mockBokioGetCompany: vi.fn(),
  mockWintGet: vi.fn(),
  mockLoginWint: vi.fn(),
}))

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

// Same shape as the BL mock above: keep the real BokioApiError for the
// instanceof checks, swap the client so the /companies probe is controllable.
vi.mock('@/lib/providers/bokio/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/bokio/client')>()
  return {
    ...actual,
    BokioClient: vi.fn().mockImplementation(function mockClient() {
      return { getCompany: mockBokioGetCompany }
    }),
  }
})

// WINT: keep the real WintApiError / WintLoginRejectedError classes (the
// instanceof branches in provider-client depend on them), swap the network.
vi.mock('@/lib/providers/wint/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/wint/client')>()
  return {
    ...actual,
    WintClient: vi.fn().mockImplementation(function mockClient() {
      return { get: mockWintGet }
    }),
  }
})

vi.mock('@/lib/providers/wint/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/wint/oauth')>()
  return {
    ...actual,
    loginWint: mockLoginWint,
  }
})

import { createServiceClient } from '@/lib/supabase/server'
import { BjornLundenApiError } from '@/lib/providers/bjornlunden/client'
import { BokioApiError } from '@/lib/providers/bokio/client'
import { WintApiError } from '@/lib/providers/wint/client'
import { WintLoginRejectedError } from '@/lib/providers/wint/oauth'
import {
  submitProviderToken,
  ProviderTokenInvalidError,
  ProviderCompanyMismatchError,
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
    mock.enqueue({ data: { org_number: '5560125790' } }) // target company lookup
    mock.enqueue({ data: null }) // consent label update
    mock.enqueue({ data: null }) // token upsert
    mockBokioGetCompany.mockResolvedValueOnce({
      name: 'Testbolaget AB',
      organizationNumber: '5560125790',
    })

    const result = await submitProviderToken('consent-1', 'bokio', 'tok', 'bokio-guid', 'company-A')

    expect(result).toEqual({ success: true, consentId: 'consent-1' })
    expect(tablesTouched()).toEqual([
      'provider_consents',
      'companies',
      'provider_consents',
      'provider_consent_tokens',
    ])
  })

  // ── Bokio company-identity guard ──────────────────────────────────
  //
  // The failure being prevented: a valid Bokio token plus a company id for the
  // WRONG company imports a foreign legal entity's customers, suppliers and
  // invoices into this ledger with no error at all.

  it('refuses to store the token when the Bokio company org number differs from the target company', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
    mock.enqueue({ data: { org_number: '5560125790' } }) // target company
    mockBokioGetCompany.mockResolvedValueOnce({
      name: 'Någon Annans Bolag AB',
      organizationNumber: '5566778899', // a different legal entity
    })

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      'bokio-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderCompanyMismatchError)
    expect(err).toMatchObject({
      expectedOrgNumber: '5560125790',
      actualOrgNumber: '5566778899',
      actualCompanyName: 'Någon Annans Bolag AB',
    })

    // Nothing was stored and the consent was NOT labelled: the connection must
    // not exist in any form, or the next step would import from it.
    expect(tablesTouched()).not.toContain('provider_consent_tokens')
    expect(tablesTouched()).toEqual(['provider_consents', 'companies'])
  })

  it('compares org numbers canonically, so formatting differences are not a mismatch', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mock.enqueue({ data: { org_number: '5560125790' } }) // stored 10-digit
    mock.enqueue({ data: null }) // consent label update
    mock.enqueue({ data: null }) // token upsert
    // Same company, hyphenated and with the century prefix Bokio may return.
    mockBokioGetCompany.mockResolvedValueOnce({
      name: 'Testbolaget AB',
      organizationNumber: '556012-5790',
    })

    await expect(
      submitProviderToken('consent-1', 'bokio', 'tok', 'bokio-guid', 'company-A'),
    ).resolves.toEqual({ success: true, consentId: 'consent-1' })

    expect(tablesTouched()).toContain('provider_consent_tokens')
  })

  it('still connects when an org number is missing on either side (absence is not evidence of mismatch)', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mock.enqueue({ data: { org_number: null } }) // company has no org number
    mock.enqueue({ data: null }) // consent label update
    mock.enqueue({ data: null }) // token upsert
    mockBokioGetCompany.mockResolvedValueOnce({
      name: 'Testbolaget AB',
      organizationNumber: '5560125790',
    })

    await expect(
      submitProviderToken('consent-1', 'bokio', 'tok', 'bokio-guid', 'company-A'),
    ).resolves.toEqual({ success: true, consentId: 'consent-1' })

    // Labelled anyway: the wizard showing WHICH company was linked is what
    // lets the user catch the mistake themselves in this case.
    expect(tablesTouched()).toContain('provider_consent_tokens')
  })

  it('maps a 404 from the Bokio probe to a company-specific failure', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    // getCompany() maps 404 to null: an unknown GUID, not an outage.
    mockBokioGetCompany.mockResolvedValueOnce(null)

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      'bad-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect(err).toMatchObject({ kind: 'company-not-found' })

    expect(tablesTouched()).not.toContain('provider_consent_tokens')
  })

  it.each([401, 403])('maps a %s from the Bokio probe to invalid credentials', async (status) => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBokioGetCompany.mockRejectedValueOnce(
      new BokioApiError(`Bokio API error: ${status}`, status),
    )

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      'bokio-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect(err).toMatchObject({ kind: 'credentials' })
  })

  it('trims the token and company id and removes a pasted Bearer prefix before probing or storing', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mock.enqueue({ data: { org_number: '5560125790' } })
    mock.enqueue({ data: null })
    mock.enqueue({ data: null })
    mockBokioGetCompany.mockResolvedValueOnce({
      name: 'Testbolaget AB',
      organizationNumber: '5560125790',
    })

    await submitProviderToken(
      'consent-1',
      'bokio',
      '  Bearer copied-token==\r\n',
      '  bokio-guid  ',
      'company-A',
    )

    expect(mockBokioGetCompany).toHaveBeenCalledWith('copied-token==', 'bokio-guid')
    expect(mock.findCall('provider_consent_tokens', 'upsert')?.[0]).toMatchObject({
      access_token: 'copied-token==',
      provider_company_id: 'bokio-guid',
    })
  })

  it('does NOT map another Bokio 4xx to invalid credentials', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBokioGetCompany.mockRejectedValueOnce(new BokioApiError('Bokio API error: 400', 400))

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      'bokio-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BokioApiError)
    expect(err).not.toBeInstanceOf(ProviderTokenInvalidError)
  })

  it('does NOT map a transient 503 from the Bokio probe to invalid credentials', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBokioGetCompany.mockRejectedValueOnce(new BokioApiError('Bokio API error: 503', 503))

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      'bokio-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BokioApiError)
    expect(err).not.toBeInstanceOf(ProviderTokenInvalidError)
    expect(tablesTouched()).not.toContain('provider_consent_tokens')
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

  it('maps a 403 "out of allowed scope" from the BL probe to integration-not-activated (live-verified body) and stores nothing', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    // Verbatim shape of BL's answer for a real customer key whose company
    // never activated the integration (2026-09-05).
    mockBlGet.mockRejectedValueOnce(
      new BjornLundenApiError(
        'Björn Lunden API error: 403 Forbidden',
        403,
        '{"headers":{},"body":{"status":"FORBIDDEN","message":"Calls to details:READ is out of allowed scope for service provider Arcim "},"statusCode":"FORBIDDEN","statusCodeValue":403}',
      ),
    )

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bjornlunden',
      'client_credentials',
      'user-key-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect((err as ProviderTokenInvalidError).kind).toBe('integration-not-activated')
    expect(tablesTouched()).not.toContain('provider_consent_tokens')
  })

  it('keeps a 403 WITHOUT the scope wording as plain rejected credentials', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBlGet.mockRejectedValueOnce(new BjornLundenApiError('Björn Lunden API error: 403', 403, ''))

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bjornlunden',
      'client_credentials',
      'user-key-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect((err as ProviderTokenInvalidError).kind).toBe('credentials')
  })

  it('reports 500 (unknown key) and 404 as company-key-not-found, not generic bad credentials', async () => {
    for (const status of [500, 404]) {
      mock.enqueue({ data: [{ id: 'consent-1' }] })
      mockBlGet.mockRejectedValueOnce(new BjornLundenApiError(`Björn Lunden API error: ${status}`, status))

      const err: unknown = await submitProviderToken(
        'consent-1',
        'bjornlunden',
        'client_credentials',
        'user-key-guid',
        'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderTokenInvalidError)
      expect((err as ProviderTokenInvalidError).kind).toBe('company-key-not-found')
    }
  })

  it('does NOT blame the pasted key for a 401 (that is our own client_credentials token being refused)', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBlGet.mockRejectedValueOnce(new BjornLundenApiError('Björn Lunden API error: 401', 401))

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bjornlunden',
      'client_credentials',
      'user-key-guid',
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BjornLundenApiError)
    expect(err).not.toBeInstanceOf(ProviderTokenInvalidError)
    expect(tablesTouched()).not.toContain('provider_consent_tokens')
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

  // ── WINT login exchange ───────────────────────────────────────────
  //
  // WINT has no API keys: the wizard sends mail (as providerCompanyId) +
  // password (as apiToken). The password is exchanged for a token pair and
  // must never reach the database.

  describe('wint', () => {
    const wintCompany = {
      Id: 4711,
      Name: 'Wintbolaget AB',
      Org: '556012-5790',
    }

    const loginOk = () =>
      mockLoginWint.mockResolvedValueOnce({
        access_token: 'wint-jwt',
        refresh_token: 'wint-refresh',
        token_type: 'Bearer',
        expires_in: 900,
      })

    it('exchanges the login, labels the consent and stores the token pair with the WINT company id', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mock.enqueue({ data: { org_number: '5560125790' } }) // target company
      mock.enqueue({ data: null }) // consent label update
      mock.enqueue({ data: null }) // token upsert
      loginOk()
      mockWintGet.mockResolvedValueOnce(wintCompany)

      const result = await submitProviderToken('consent-1', 'wint', 'hemligt', 'user@bolag.se', 'company-A')

      expect(result).toEqual({ success: true, consentId: 'consent-1' })
      expect(mockLoginWint).toHaveBeenCalledWith('user@bolag.se', 'hemligt')
      expect(tablesTouched()).toEqual([
        'provider_consents',
        'companies',
        'provider_consents',
        'provider_consent_tokens',
      ])
      // The stored row carries the token pair and the WINT company id; the
      // login mail and password must never reach the database.
      const upsert = mock.findCall('provider_consent_tokens', 'upsert')?.[0] as Record<string, unknown>
      expect(upsert).toMatchObject({
        provider: 'wint',
        access_token: 'wint-jwt',
        refresh_token: 'wint-refresh',
        provider_company_id: '4711',
      })
      expect(JSON.stringify(upsert)).not.toContain('user@bolag.se')
      expect(JSON.stringify(upsert)).not.toContain('hemligt')
    })

    it('rejects a login WINT refused (WrongUsernameOrPassword) without writing tokens', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mockLoginWint.mockRejectedValueOnce(new WintLoginRejectedError('WrongUsernameOrPassword'))

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', 'fel-lösenord', 'user@bolag.se', 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderTokenInvalidError)
      expect((err as Error).message).toContain('WrongUsernameOrPassword')
      expect(tablesTouched()).toEqual(['provider_consents'])
    })

    it('requires a login e-mail in the companyId field', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', 'lösenord', undefined, 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderTokenInvalidError)
      expect(mockLoginWint).not.toHaveBeenCalled()
    })

    it('refuses to store tokens when the WINT company org number differs from the target company', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mock.enqueue({ data: { org_number: '5566778899' } }) // a DIFFERENT target company
      loginOk()
      mockWintGet.mockResolvedValueOnce(wintCompany)

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', 'hemligt', 'user@bolag.se', 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderCompanyMismatchError)
      expect((err as ProviderCompanyMismatchError).actualOrgNumber).toBe('5560125790')
      // No token upsert, no consent label write
      expect(tablesTouched()).toEqual(['provider_consents', 'companies'])
    })

    it('rethrows transient login failures (5xx) as generic errors, not invalid credentials', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mockLoginWint.mockRejectedValueOnce(new WintApiError('WINT login failed: 503', 503))

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', 'hemligt', 'user@bolag.se', 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(WintApiError)
      expect(err).not.toBeInstanceOf(ProviderTokenInvalidError)
    })
  })
})
