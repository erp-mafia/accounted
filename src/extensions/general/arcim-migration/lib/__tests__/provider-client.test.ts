import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockBlGet, mockBokioGetCompany, mockWintGet, mockLogWarn } = vi.hoisted(() => ({
  mockBlGet: vi.fn(),
  mockBokioGetCompany: vi.fn(),
  mockWintGet: vi.fn(),
  mockLogWarn: vi.fn(),
}))

// Capture only provider-client's own warnings (what a Bokio refusal logs);
// every other module keeps the real logger.
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Record<string, unknown>) => {
      const logger = actual.createLogger(module, base)
      return module === 'extensions/arcim-migration/provider-client'
        ? { ...logger, warn: mockLogWarn }
        : logger
    },
  }
})

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

// WINT: keep the real WintApiError class (the instanceof branch in
// provider-client depends on it) and wintAppCredential, swap the network.
vi.mock('@/lib/providers/wint/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/wint/client')>()
  return {
    ...actual,
    WintClient: vi.fn().mockImplementation(function mockClient() {
      return { get: mockWintGet }
    }),
  }
})

import { createServiceClient } from '@/lib/supabase/server'
import { openConsentToken } from '@/lib/providers/consent-tokens'
import { BjornLundenApiError } from '@/lib/providers/bjornlunden/client'
import { BokioApiError } from '@/lib/providers/bokio/client'
import { WintApiError, wintAppCredential } from '@/lib/providers/wint/client'
import {
  submitProviderToken,
  ProviderTokenInvalidError,
  ProviderCompanyMismatchError,
  ConsentNotFoundError,
} from '../provider-client'

// Bokio company ids are GUIDs.
const BOKIO_ID = '9b408943-7a1e-47ac-85a7-ac52b2c210d3'
const UNKNOWN_BOKIO_ID = '00000000-0000-4000-8000-000000000000'

describe('submitProviderToken', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-personnummer-key')
    mock = createQueuedMockSupabase()
    vi.mocked(createServiceClient).mockReturnValue(mock.supabase as never)
  })
  afterEach(() => vi.unstubAllEnvs())

  const tablesTouched = () => vi.mocked(mock.supabase.from).mock.calls.map((c) => c[0])

  // ── Consent ownership (IDOR guard) ────────────────────────────────

  it('throws ConsentNotFoundError and writes NOTHING when the consent belongs to another company', async () => {
    // Ownership check finds no row for (consentId, ownerCompanyId): the same
    // result whether the consent does not exist or belongs to another tenant.
    mock.enqueue({ data: [] })

    await expect(
      submitProviderToken('consent-other-tenant', 'bokio', 'tok', BOKIO_ID, 'company-A'),
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

    const result = await submitProviderToken('consent-1', 'bokio', 'tok', BOKIO_ID, 'company-A')

    expect(result).toEqual({ success: true, consentId: 'consent-1' })
    expect(tablesTouched()).toEqual([
      'provider_consents',
      'company_settings',
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
      BOKIO_ID,
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
    expect(tablesTouched()).toEqual(['provider_consents', 'company_settings'])
  })

  it('checks against a number held in settings alone, and one whose check digit fails', async () => {
    for (const stored of ['5560125790', '5560125791']) {
      mock.reset()
      mock.enqueue({ data: [{ id: 'consent-1' }] })
      mock.enqueue({ data: { org_number: stored } })
      mockBokioGetCompany.mockResolvedValueOnce({ name: 'Någon Annans Bolag AB', organizationNumber: '5566778899' })
      const err: unknown = await submitProviderToken('consent-1', 'bokio', 'tok', BOKIO_ID, 'company-A').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderCompanyMismatchError)
    }
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
      submitProviderToken('consent-1', 'bokio', 'tok', BOKIO_ID, 'company-A'),
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
      submitProviderToken('consent-1', 'bokio', 'tok', BOKIO_ID, 'company-A'),
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
      UNKNOWN_BOKIO_ID,
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect(err).toMatchObject({ kind: 'company-not-found' })

    expect(tablesTouched()).not.toContain('provider_consent_tokens')
  })

  // 2026-10-27: a value without a GUID drew a Bokio 400 that the route
  // answered with "try again", five times for one user.
  it.each([
    ['an org number', '556012-5790'],
    ['the integration token in the wrong field', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl'],
    ['two GUIDs to choose between', `${BOKIO_ID} ${UNKNOWN_BOKIO_ID}`],
  ])('refuses %s as the company id before asking Bokio, storing nothing', async (_case, pasted) => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })

    const err: unknown = await submitProviderToken('consent-1', 'bokio', 'tok', pasted, 'company-A')
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect(err).toMatchObject({ kind: 'company-id-invalid' })
    expect(mockBokioGetCompany).not.toHaveBeenCalled()
    expect(tablesTouched()).toEqual(['provider_consents'])
  })

  it('takes the GUID out of a pasted Bokio address and asks Bokio with it alone', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mock.enqueue({ data: { org_number: '5560125790' } })
    mock.enqueue({ data: null })
    mock.enqueue({ data: null })
    mockBokioGetCompany.mockResolvedValueOnce({ name: 'Testbolaget AB', organizationNumber: '5560125790' })

    await expect(submitProviderToken('consent-1', 'bokio', 'tok',
      ` https://app.bokio.se/${BOKIO_ID}/overview `, 'company-A')).resolves.toEqual({ success: true, consentId: 'consent-1' })

    expect(mockBokioGetCompany).toHaveBeenCalledWith('tok', BOKIO_ID)
    const upsert = mock.findCall('provider_consent_tokens', 'upsert')?.[0] as { provider_company_id?: string } | undefined
    expect(upsert?.provider_company_id).toBe(BOKIO_ID)
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
      BOKIO_ID,
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect(err).toMatchObject({ kind: 'credentials' })
  })

  // ── Bokio plan refusal ────────────────────────────────────────────
  //
  // A plan without API access (Basic, or an expired plan) answers 403
  // price_plan_feature_required on every company endpoint. The token can be
  // fine, so this is its own verdict, not "check the credentials".

  const PLAN_REFUSAL_BODY = JSON.stringify({
    error: 'price_plan_feature_required',
    message: 'This feature requires a plan with API access',
    details: { requiredFeature: 'PrivateApi', availableIn: ['Plus', 'Premium', 'Business'] },
  })

  it('maps a 403 plan refusal from the Bokio probe to plan-no-api, stores nothing and logs only the status and code', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBokioGetCompany.mockRejectedValueOnce(
      new BokioApiError('Bokio API error: 403 Forbidden', 403, PLAN_REFUSAL_BODY),
    )

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'secret-integration-token',
      BOKIO_ID,
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect(err).toMatchObject({ kind: 'plan-no-api' })
    expect(tablesTouched()).not.toContain('provider_consent_tokens')

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Bokio refused the integration token probe',
      { consentId: 'consent-1', status: 403, bokioErrorCode: 'price_plan_feature_required' },
    )
    const logged = JSON.stringify(mockLogWarn.mock.calls)
    expect(logged).not.toContain('secret-integration-token')
    expect(logged).not.toContain('This feature requires')
  })

  it('keeps any other Bokio 403 as invalid credentials and still logs its code', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBokioGetCompany.mockRejectedValueOnce(
      new BokioApiError(
        'Bokio API error: 403 Forbidden',
        403,
        JSON.stringify({ code: 'forbidden', message: 'The token lacks a required scope' }),
      ),
    )

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      BOKIO_ID,
      'company-A',
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderTokenInvalidError)
    expect(err).toMatchObject({ kind: 'credentials' })
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Bokio refused the integration token probe',
      { consentId: 'consent-1', status: 403, bokioErrorCode: 'forbidden' },
    )
  })

  it('treats only a 403 as a plan refusal, never a 401 that happens to carry the string', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBokioGetCompany.mockRejectedValueOnce(
      new BokioApiError('Bokio API error: 401 Unauthorized', 401, PLAN_REFUSAL_BODY),
    )

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      BOKIO_ID,
      'company-A',
    ).catch((e: unknown) => e)

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
      `  ${BOKIO_ID}  `,
      'company-A',
    )

    expect(mockBokioGetCompany).toHaveBeenCalledWith('copied-token==', BOKIO_ID)
    const upsert = mock.findCall('provider_consent_tokens', 'upsert')?.[0] as Record<string, string>
    expect(upsert).toMatchObject({ provider_company_id: BOKIO_ID })
    expect(openConsentToken(upsert.access_token!)).toBe('copied-token==')
  })

  it('does NOT map another Bokio 4xx to invalid credentials', async () => {
    mock.enqueue({ data: [{ id: 'consent-1' }] })
    mockBokioGetCompany.mockRejectedValueOnce(new BokioApiError('Bokio API error: 400', 400))

    const err: unknown = await submitProviderToken(
      'consent-1',
      'bokio',
      'tok',
      BOKIO_ID,
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
      BOKIO_ID,
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

  // ── WINT ──────────────────────────────────────────────────────────
  //
  // The forms send the username (as providerCompanyId) and API key (as
  // apiToken) of an app the customer creates inside WINT. Nothing logs in:
  // WINT refused the account's own login for an account that requires BankID
  // (prod, 2026-11-19), and the answer read "check the details and try
  // again".

  describe('wint', () => {
    const wintCompany = {
      Id: 4711,
      Name: 'Wintbolaget AB',
      Org: '556012-5790',
    }
    const apiKey = '0b7f5c1e-2a44-4d0c-9f5e-6d1f0a2b3c4d'
    const credential = wintAppCredential('app-user', apiKey)

    /** The rows a connect reads and writes when everything matches. */
    const connectOk = () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mock.enqueue({ data: { org_number: '5560125790' } }) // target company
      mock.enqueue({ data: null }) // consent label update
      mock.enqueue({ data: null }) // token upsert
      mockWintGet.mockResolvedValueOnce(wintCompany)
    }

    it("connects with the app's username and API key, labels the consent and stores the sealed credential", async () => {
      connectOk()

      const result = await submitProviderToken('consent-1', 'wint', ` ${apiKey} `, ' app-user ', 'company-A')

      expect(result).toEqual({ success: true, consentId: 'consent-1' })
      // The probe that learns the company runs on the app credential.
      expect(mockWintGet).toHaveBeenCalledWith(credential, '/api/Auth')
      expect(tablesTouched()).toEqual([
        'provider_consents',
        'company_settings',
        'provider_consents',
        'provider_consent_tokens',
      ])
      // Nothing expires and nothing refreshes; the WINT company id is kept.
      const upsert = mock.findCall('provider_consent_tokens', 'upsert')?.[0] as Record<string, string | null>
      expect(upsert).toMatchObject({
        provider: 'wint',
        provider_company_id: '4711',
        refresh_token: null,
        token_expires_at: null,
      })
      expect(openConsentToken(upsert.access_token!)).toBe(credential)
      // Sealed at rest: neither the key nor the username in the clear.
      expect(JSON.stringify(upsert)).not.toContain(apiKey)
      expect(JSON.stringify(upsert)).not.toContain('app-user')
    })

    it('takes an e-mail shaped username like any other', async () => {
      connectOk()

      await submitProviderToken('consent-1', 'wint', apiKey, 'app@bolag.se', 'company-A')

      expect(mockWintGet).toHaveBeenCalledWith(wintAppCredential('app@bolag.se', apiKey), '/api/Auth')
    })

    // What a user who types their WINT login gets: no API key, so nothing is
    // sent to WINT and nothing is stored.
    it('refuses what is no API key before anything leaves, the password of a login included', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', 'hemligt-lösenord', 'user@bolag.se', 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderTokenInvalidError)
      expect((err as ProviderTokenInvalidError).kind).toBe('api-key-invalid')
      expect(mockWintGet).not.toHaveBeenCalled()
      expect(tablesTouched()).toEqual(['provider_consents'])
    })

    it('requires the app username in the companyId field', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', apiKey, undefined, 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderTokenInvalidError)
      expect(mockWintGet).not.toHaveBeenCalled()
    })

    it('reports app credentials WINT refuses (401) as invalid, without writing tokens', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mockWintGet.mockRejectedValueOnce(new WintApiError('WINT API error: 401', 401))

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', apiKey, 'app-user', 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderTokenInvalidError)
      expect((err as ProviderTokenInvalidError).kind).toBe('credentials')
      expect(tablesTouched()).toEqual(['provider_consents'])
    })

    it('rethrows a WINT outage on the probe (5xx) as a generic error, not invalid credentials', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mockWintGet.mockRejectedValueOnce(new WintApiError('WINT API error: 503', 503))

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', apiKey, 'app-user', 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(WintApiError)
      expect(err).not.toBeInstanceOf(ProviderTokenInvalidError)
    })

    it('refuses to store the credential when the WINT company org number differs from the target company', async () => {
      mock.enqueue({ data: [{ id: 'consent-1' }] }) // ownership check
      mock.enqueue({ data: { org_number: '5566778899' } }) // a DIFFERENT target company
      mockWintGet.mockResolvedValueOnce(wintCompany)

      const err: unknown = await submitProviderToken(
        'consent-1', 'wint', apiKey, 'app-user', 'company-A',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ProviderCompanyMismatchError)
      expect((err as ProviderCompanyMismatchError).actualOrgNumber).toBe('5560125790')
      // No token upsert, no consent label write
      expect(tablesTouched()).toEqual(['provider_consents', 'company_settings'])
    })
  })
})
