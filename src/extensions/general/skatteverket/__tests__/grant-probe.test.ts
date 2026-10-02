/**
 * Grant verification: the ombudsregister (Ombudshantering v2) decides when it
 * answers, and a grant counts only when it was signed on or after the
 * company's own opt-in for the org number. The read-service probes (200 /
 * felkod 3 / OMBUD_GRANT_MISSING / 404 / transient) speak only when the
 * register cannot be consulted, and since they cannot see when anything was
 * signed they can deny but never grant. The transient-error-never-downgrades
 * rule lives in connection-store's recordProbeResult and is asserted through
 * the recorded input here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSkvRequestWithAuth = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    skvRequestWithAuth: (...a: unknown[]) => mockSkvRequestWithAuth(...a),
  }
})

const mockRecordProbeResult = vi.fn()
const mockGetConnection = vi.fn()
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a),
    getConnection: (...a: unknown[]) => mockGetConnection(...a),
  }
})

import { probeCompanyGrants, probeViaOmbudsregister } from '../lib/grant-probe'
import { SkatteverketAuthError } from '../lib/api-client'

const ORG = '165560000000'
const TODAY = '2026-09-01'
/** The company opted in (deep link or Verifiera) before the grants below were signed. */
const OPT_IN_AT = '2026-07-01T10:00:00Z'

/** The register call is always first; make it fail so the service probes decide. */
function registryUnavailable() {
  mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'down' })
}

function registryAnswers(posts: unknown[]) {
  mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => posts })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRecordProbeResult.mockResolvedValue({ id: 'conn-1', status: 'verified' })
  mockGetConnection.mockResolvedValue({ id: 'conn-1', org_number: ORG, created_at: OPT_IN_AT })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('probeCompanyGrants via the ombudsregister', () => {
  it('both roles active today -> both granted, source registry, no service probes', async () => {
    registryAnswers([
      { huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', ombud: '165590000000', giltigFrom: '2026-07-19' },
      { huvudman: ORG, roll: 'MOMS', rollbeskrivning: 'Momsdeklaration, ombud', ombud: '165590000000', giltigFrom: '2026-07-19', giltigTom: '' },
    ])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('registry')
    expect(result.lasombud.status).toBe('granted')
    expect(result.momsOmbud.status).toBe('granted')
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(1)
    // System identity, ombud base URL, Accept header, huvudman filter.
    const [auth, method, path, , options] = mockSkvRequestWithAuth.mock.calls[0]
    expect(auth).toEqual({ mode: 'system' })
    expect(method).toBe('GET')
    expect(path).toBe(`/ombud/autentisieratOmbud?huvudman=${ORG}`)
    expect(options).toMatchObject({
      baseUrl: 'https://api.test.skatteverket.se/behorighet/ombudshantering/v2',
      accept: 'application/json',
    })
  })

  it('only läsombud granted -> moms denied with the roles listed in the detail', async () => {
    registryAnswers([
      { huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-07-19' },
      { huvudman: ORG, roll: 'DEKL', rollbeskrivning: 'Deklarationsombud', giltigFrom: '2026-07-19' },
    ])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('granted')
    expect(result.momsOmbud.status).toBe('denied')
    expect(result.momsOmbud.detail).toContain('JLO, DEKL')
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        lasombud: expect.objectContaining({ status: 'granted' }),
        momsOmbud: expect.objectContaining({ status: 'denied' }),
        error: null,
      })
    )
  })

  it('a 200 with no posts for the huvudman -> both denied (the company never granted)', async () => {
    registryAnswers([])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('registry')
    expect(result.lasombud.status).toBe('denied')
    expect(result.momsOmbud.status).toBe('denied')
  })

  it('a future-dated or expired grant does not count', async () => {
    const future = await probeViaOmbudsregisterWith([
      { huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-12-01' },
    ])
    expect(future.result?.lasombud.status).toBe('denied')

    const expired = await probeViaOmbudsregisterWith([
      { huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2025-01-01', giltigTom: '2026-08-31' },
    ])
    expect(expired.result?.lasombud.status).toBe('denied')

    const active = await probeViaOmbudsregisterWith([
      { huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2025-01-01', giltigTom: '2026-09-01' },
    ])
    expect(active.result?.lasombud.status).toBe('granted')
  })

  it('a register 404 is a transport fault: falls back to the service probes instead of denying', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"message":"Not found"}' })
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('service')
    // The read probe proves access but not the signing day: never a grant.
    expect(result.lasombud.status).toBe('error')
    expect(result.lasombud.detail).toContain('OBR_HTTP_ERROR')
  })

  it('grants that classify as neither behörighet are an error (unrecognised role codes), never a denial', async () => {
    registryAnswers([
      { huvudman: ORG, roll: 'ZZ1', rollbeskrivning: 'Läsombud, juridisk person', giltigFrom: '2026-07-19' },
      { huvudman: ORG, roll: 'ZZ2', rollbeskrivning: 'Ombud för momsdeklaration', giltigFrom: '2026-07-19' },
    ])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('registry')
    expect(result.lasombud.status).toBe('error')
    expect(result.momsOmbud.status).toBe('error')
    expect(result.lasombud.detail).toContain('ZZ1, ZZ2')
    expect(mockRecordProbeResult.mock.calls[0][0].error).toBeTruthy()
  })

  it('a register 403 (scope/avtal missing) is an error, never a company denial', async () => {
    // api-client maps a system-mode 403 to OMBUD_GRANT_MISSING; on the register that is run-level.
    mockSkvRequestWithAuth.mockRejectedValueOnce(new SkatteverketAuthError('nope', 'OMBUD_GRANT_MISSING'))
    // Fallback service probes both succeed.
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('service')
    expect(result.lasombud.status).toBe('error')
    expect(result.lasombud.detail).toContain('OBR_FORBIDDEN')
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(3)
  })
})

async function probeViaOmbudsregisterWith(posts: unknown[], optInDay = '2024-12-01') {
  registryAnswers(posts)
  return probeViaOmbudsregister(ORG, optInDay, TODAY)
}

describe('org-number proof: only grants signed on or after the opt-in count', () => {
  it('a grant signed before the opt-in is denied with reason predates_opt_in', async () => {
    const result = await probeViaOmbudsregisterWith(
      [{ huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-05-10' }],
      '2026-08-20'
    )
    expect(result.result?.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
    expect(result.result?.lasombud.detail).toContain('2026-05-10')
    // A role never granted is a plain denial, no reason.
    expect(result.result?.momsOmbud.reason).toBeUndefined()
  })

  it('a grant signed on the opt-in day counts, and a re-signed newer post wins over an old one', async () => {
    const sameDay = await probeViaOmbudsregisterWith(
      [{ huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-08-20' }],
      '2026-08-20'
    )
    expect(sameDay.result?.lasombud.status).toBe('granted')

    const resigned = await probeViaOmbudsregisterWith(
      [
        { huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2025-02-01' },
        { huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-08-21' },
      ],
      '2026-08-20'
    )
    expect(resigned.result?.lasombud.status).toBe('granted')
  })

  it('a first Verifiera (no row yet) opts in today: an older grant does not count', async () => {
    mockGetConnection.mockResolvedValueOnce(null)
    registryAnswers([{ huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-01-15' }])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({ lasombud: expect.objectContaining({ reason: 'predates_opt_in' }) })
    )
  })

  it('a row recorded for another org number opts in today for the new one', async () => {
    mockGetConnection.mockResolvedValueOnce({ id: 'conn-1', org_number: '165599999999', created_at: '2025-01-01T00:00:00Z' })
    registryAnswers([{ huvudman: ORG, roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-01-15' }])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('denied')
  })
})

describe('probeCompanyGrants service-probe fallback', () => {
  it('both probes 200 -> error, never granted: the signing day is unknown without the register', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 }) // saldo
      .mockResolvedValueOnce({ ok: true, status: 200 }) // utkast

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('service')
    expect(result.lasombud.status).toBe('error')
    expect(result.momsOmbud.status).toBe('error')
    expect(result.lasombud.detail).toContain('signeringsdag okänd')
    // All calls ran on SYSTEM credentials.
    for (const call of mockSkvRequestWithAuth.mock.calls) expect(call[0]).toEqual({ mode: 'system' })
    // The fallback reason travels in the detail for the settings panel/probe row.
    expect(result.lasombud.detail).toContain('ombudsregister otillgängligt')
  })

  it('records the actual 2xx status as detail, not a hardcoded 200', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 204 }) // saldo
      .mockResolvedValueOnce({ ok: true, status: 200 }) // utkast

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('error')
    expect(result.lasombud.detail.startsWith('204')).toBe(true)
    expect(result.momsOmbud.detail.startsWith('200')).toBe(true)
  })

  it('felkod 3 (no skattekonto) proves access but, like a 200, cannot grant', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ felkod: 3 }) })
      .mockResolvedValueOnce({ ok: false, status: 404 })

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('error')
    expect(result.lasombud.detail).toContain('felkod 3')
    // 404 on /utkast = no draft, but the gateway authorized us: still not a grant.
    expect(result.momsOmbud.status).toBe('error')
  })

  it('OMBUD_GRANT_MISSING on the read services classifies as denied', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockRejectedValueOnce(new SkatteverketAuthError('saknas', 'OMBUD_GRANT_MISSING'))
      .mockRejectedValueOnce(new SkatteverketAuthError('saknas', 'OMBUD_GRANT_MISSING'))

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('denied')
    expect(result.momsOmbud.status).toBe('denied')
  })

  it('transient failures classify as error, never denied', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockRejectedValueOnce(new SkatteverketAuthError('overload', 'RATE_LIMITED'))
      .mockRejectedValueOnce(new Error('fetch failed'))

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('error')
    expect(result.momsOmbud.status).toBe('error')

    const recorded = mockRecordProbeResult.mock.calls[0][0]
    expect(recorded.error).toBeTruthy()
  })

  it('persists the probe outcome via recordProbeResult', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    await probeCompanyGrants('company-1', ORG, 'user-1')

    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        orgNumber: ORG,
        createdBy: 'user-1',
        lasombud: expect.objectContaining({ status: 'error' }),
        momsOmbud: expect.objectContaining({ status: 'error' }),
        error: expect.stringContaining('signeringsdag okänd'),
      })
    )
  })
})
