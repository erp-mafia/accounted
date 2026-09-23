/**
 * Grant verification: the ombudsregister (Ombudshantering v2) decides when it
 * answers; the read-service probes (200 / felkod 3 / OMBUD_GRANT_MISSING /
 * 404 / transient) decide only when the register cannot be consulted. The
 * transient-error-never-downgrades rule lives in connection-store's
 * recordProbeResult and is asserted through the recorded input here.
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
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a),
  }
})

import { probeCompanyGrants, probeViaOmbudsregister } from '../lib/grant-probe'
import { SkatteverketAuthError } from '../lib/api-client'

const ORG = '165560000000'
const TODAY = '2026-09-01'

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
    expect(result.lasombud.status).toBe('granted')
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
    expect(result.lasombud.status).toBe('granted')
    expect(result.lasombud.detail).toContain('OBR_FORBIDDEN')
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(3)
  })
})

async function probeViaOmbudsregisterWith(posts: unknown[]) {
  registryAnswers(posts)
  return probeViaOmbudsregister(ORG, TODAY)
}

describe('probeCompanyGrants service-probe fallback', () => {
  it('both probes 200 -> both granted', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 }) // saldo
      .mockResolvedValueOnce({ ok: true, status: 200 }) // utkast

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('service')
    expect(result.lasombud.status).toBe('granted')
    expect(result.momsOmbud.status).toBe('granted')
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

    expect(result.lasombud.status).toBe('granted')
    expect(result.lasombud.detail.startsWith('204')).toBe(true)
    expect(result.momsOmbud.detail.startsWith('200')).toBe(true)
  })

  it('felkod 3 (no skattekonto) still proves the lasombud authorization', async () => {
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ felkod: 3 }) })
      .mockResolvedValueOnce({ ok: false, status: 404 })

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('granted')
    // 404 on /utkast = no draft, but the gateway authorized us.
    expect(result.momsOmbud.status).toBe('granted')
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
        lasombud: expect.objectContaining({ status: 'granted' }),
        momsOmbud: expect.objectContaining({ status: 'granted' }),
        error: null,
      })
    )
  })
})
