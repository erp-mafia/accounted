import { afterEach, describe, expect, it, vi } from 'vitest'

// The JWT signer needs real credentials; the fetch below is stubbed anyway.
vi.mock('../jwt', () => ({
  getAuthorizationHeader: () => 'Bearer test-token',
  hasSigningCredentials: () => true,
}))

import {
  AspspUnavailableError,
  ConnectorSyncError,
  getAllTransactionsWithRaw,
  isCredentialRejection,
  ProviderCredentialError,
  SessionExpiredError,
} from '../api-client'
import { createProviderCircuit, CREDENTIAL_TRIP_ATTEMPTS, isCredentialRejectionError } from '../provider-circuit'

const refused = () => new ProviderCredentialError(401, '{"error":"Unauthorized"}')
const consentDead = () => new SessionExpiredError(401, '{"error":"CLOSED_SESSION"}')

describe('isCredentialRejection', () => {
  it('is a 401/403 that names no session: the application refused, not a consent', () => {
    expect(isCredentialRejection(401, '{"error":"Unauthorized"}')).toBe(true)
    expect(isCredentialRejection(403, '{"message":"Forbidden"}')).toBe(true)
    expect(isCredentialRejection(401, '')).toBe(true)
    // A dead consent is its own thing (SessionExpiredError), never a credential problem.
    expect(isCredentialRejection(401, '{"error":"CLOSED_SESSION"}')).toBe(false)
    expect(isCredentialRejection(403, '{"message":"Session is closed"}')).toBe(false)
    // Other statuses say nothing about credentials.
    expect(isCredentialRejection(400, '{"error":"ASPSP_ERROR"}')).toBe(false)
    expect(isCredentialRejection(429, '{"error":"Unauthorized"}')).toBe(false)
    expect(isCredentialRejection(500, 'Unauthorized')).toBe(false)
  })
})

describe('getAllTransactionsWithRaw: the application refused', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('throws ProviderCredentialError on a bare 401, with one warn line and no error line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":"Unauthorized"}',
    })))

    const failed = getAllTransactionsWithRaw('acc-1', '2026-10-01', '2026-11-10')
    await expect(failed).rejects.toBeInstanceOf(ProviderCredentialError)
    await expect(failed).rejects.toMatchObject({ status: 401 })
    expect(warn.mock.calls.some((call) => String(call[0]).includes('application credentials refused'))).toBe(true)
    expect(error).not.toHaveBeenCalled()
  })

  it('still throws SessionExpiredError when the 401 names the session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '{"error":"SESSION_EXPIRED"}',
    })))
    await expect(getAllTransactionsWithRaw('acc-1', '2026-10-01', '2026-11-10')).rejects.toBeInstanceOf(SessionExpiredError)
  })
})

describe('the provider circuit', () => {
  it('trips when the first two connections tried were both refused at the credential level', () => {
    const circuit = createProviderCircuit()
    expect(CREDENTIAL_TRIP_ATTEMPTS).toBe(2)
    circuit.record(refused())
    expect(circuit.tripped).toBe(false)
    circuit.record(refused())
    expect(circuit.tripped).toBe(true)
    expect(circuit).toMatchObject({ attempts: 2, credentialFailures: 2 })
    // Whatever was in flight finishes and is counted; the trip holds.
    circuit.record(refused())
    circuit.record(null)
    expect(circuit.tripped).toBe(true)
    expect(circuit).toMatchObject({ attempts: 4, credentialFailures: 3 })
  })

  it('does not trip on a dead consent, a bank refusing, a connector hop failing, a plain error or a success', () => {
    for (const first of [consentDead(), new AspspUnavailableError(400, '{}', 'ladder-exhausted', undefined), new ConnectorSyncError(502, 'HTTP_502', ''), new Error('ASPSP 500'), null]) {
      const circuit = createProviderCircuit()
      circuit.record(first)
      circuit.record(refused())
      expect(circuit.tripped).toBe(false)
      expect(circuit.credentialFailures).toBe(1)
    }
    // Two consent expiries in a row: two people to re-authorise, not the provider gone.
    const consents = createProviderCircuit()
    consents.record(consentDead())
    consents.record(consentDead())
    expect(consents.tripped).toBe(false)
    expect(consents.credentialFailures).toBe(0)
  })

  it('reads only the first two connections: a refusal later in the run does not stop it', () => {
    const circuit = createProviderCircuit()
    circuit.record(null)
    circuit.record(refused())
    circuit.record(refused())
    circuit.record(refused())
    expect(circuit.tripped).toBe(false)
    expect(circuit.credentialFailures).toBe(3)
  })

  it('recognises the typed error alone', () => {
    expect(isCredentialRejectionError(refused())).toBe(true)
    expect(isCredentialRejectionError(consentDead())).toBe(false)
    expect(isCredentialRejectionError(new Error('Failed to get transactions (401): Unauthorized'))).toBe(false)
    expect(isCredentialRejectionError(null)).toBe(false)
  })
})
