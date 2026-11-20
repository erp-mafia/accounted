/**
 * Grant verification: the ombudsregister (Ombudshantering v2) decides when it
 * answers, and a grant counts when it was signed on or after the company's
 * own opt-in for the org number, or earlier for a company that proved the
 * number with BankID. The read-service probes (200 /
 * felkod 3 / OMBUD_GRANT_MISSING / 404 / transient) speak only when the
 * register cannot be consulted, and since they cannot see when anything was
 * signed they can deny but never grant. The transient-error-never-downgrades
 * rule lives in connection-store's recordProbeResult and is asserted through
 * the recorded input here.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'

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
const mockFindProof = vi.fn()
/** Per behörighet, the day company-1 last proved that data with BankID. */
let proofDays: Partial<Record<'lasombud' | 'moms_ombud', string>> = {}
function proven(days: typeof proofDays) {
  proofDays = days
  mockFindProof.mockImplementation(async (_claims: unknown, key: 'lasombud' | 'moms_ombud') =>
    new Map(proofDays[key] ? [['company-1', proofDays[key]!]] : [])
  )
}
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a),
    getConnectionOrThrow: (...a: unknown[]) => mockGetConnection(...a),
    getConnection: (...a: unknown[]) => mockGetConnection(...a),
    findCompaniesWithOwnershipProof: (...a: unknown[]) => mockFindProof(...a),
  }
})

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createLogger: () => log,
}))

import { grantRefusalIsNew, probeCompanyGrants, probeViaOmbudsregister, recordGrantRefusal } from '../lib/grant-probe'
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
  mockFindProof.mockResolvedValue(new Map())
  proofDays = {}
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('probeCompanyGrants via the ombudsregister', () => {
  it('both roles active today -> both granted, source registry, no service probes', async () => {
    registryAnswers([
      { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', ombud: '165590000000', giltigFrom: '2026-07-19' },
      { huvudman: ORG, roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud', ombud: '165590000000', giltigFrom: '2026-07-19', giltigTom: '' },
    ])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.source).toBe('registry')
    expect(result.lasombud.status).toBe('granted')
    expect(result.momsOmbud.status).toBe('granted')
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(1)
    // System identity, ombud base URL, Accept header, huvudman filter.
    const [auth, method, path, audit, , options] = mockSkvRequestWithAuth.mock.calls[0]
    expect(auth).toEqual({ mode: 'system' })
    expect(method).toBe('GET')
    expect(path).toBe(`/ombud/autentisieratOmbud?huvudman=${ORG}`)
    // No user asked (no createdBy): audited against the company as a system call.
    expect(audit).toEqual({
      endpoint: 'ombud/autentisieratOmbud',
      companyId: 'company-1',
      userId: null,
      agRegistreradId: ORG,
      expectJson: true,
    })
    expect(options).toMatchObject({
      baseUrl: 'https://api.test.skatteverket.se/behorighet/ombudshantering/v2',
      accept: 'application/json',
    })
  })

  it('only läsombud granted -> moms denied with the roles listed in the detail', async () => {
    registryAnswers([
      { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-07-19' },
      { huvudman: ORG, roll: 'DEKL', rollbeskrivning: 'Deklarationsombud', giltigFrom: '2026-07-19' },
    ])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('granted')
    expect(result.momsOmbud.status).toBe('denied')
    expect(result.momsOmbud.detail).toContain('skol, DEKL')
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
      { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-12-01' },
    ])
    expect(future.result?.lasombud.status).toBe('denied')

    const expired = await probeViaOmbudsregisterWith([
      { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2025-01-01', giltigTom: '2026-08-31' },
    ])
    expect(expired.result?.lasombud.status).toBe('denied')

    const active = await probeViaOmbudsregisterWith([
      { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2025-01-01', giltigTom: '2026-09-01' },
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

async function probeViaOmbudsregisterWith(posts: unknown[], optInDay = '2024-12-01', lasombudProof: string | null = null) {
  registryAnswers(posts)
  return probeViaOmbudsregister(
    ORG,
    { optInDay, provenOn: { lasombud: lasombudProof, moms_ombud: null } },
    { companyId: 'company-1', userId: null },
    TODAY
  )
}

describe('the Swedish day and month', () => {
  // 00:30 on 1 January in Sweden, still 31 December in UTC.
  afterEach(() => {
    vi.useRealTimers()
  })
  const newYearNight = () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
  }

  it("a first Verifiera on New Year's night opts in on the new year's first day", async () => {
    newYearNight()
    mockGetConnection.mockResolvedValueOnce(null)
    registryAnswers([{ huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2027-01-01' }])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('granted')
  })

  it("an opt-in made on New Year's night is dated on the Swedish day", async () => {
    newYearNight()
    mockGetConnection.mockResolvedValueOnce({ id: 'conn-1', org_number: ORG, created_at: '2026-12-31T23:30:00Z' })
    registryAnswers([{ huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-12-31' }])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
  })

  it('the service probe asks for the Swedish moms period', async () => {
    newYearNight()
    registryUnavailable()
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 }) // saldo
      .mockResolvedValueOnce({ ok: true, status: 200 }) // utkast

    await probeCompanyGrants('company-1', ORG)

    expect(mockSkvRequestWithAuth.mock.calls.some((call) => String(call[2]).endsWith('/202701'))).toBe(true)
  })
})

describe('org-number proof: only grants signed on or after the opt-in count', () => {
  it('a grant signed before the opt-in is denied with reason predates_opt_in', async () => {
    const result = await probeViaOmbudsregisterWith(
      [{ huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-05-10' }],
      '2026-08-20'
    )
    expect(result.result?.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
    expect(result.result?.lasombud.detail).toContain('2026-05-10')
    // A role never granted is a plain denial, no reason.
    expect(result.result?.momsOmbud.reason).toBeUndefined()
  })

  it('a grant signed on the opt-in day counts, and a re-signed newer post wins over an old one', async () => {
    const sameDay = await probeViaOmbudsregisterWith(
      [{ huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-08-20' }],
      '2026-08-20'
    )
    expect(sameDay.result?.lasombud.status).toBe('granted')

    const resigned = await probeViaOmbudsregisterWith(
      [
        { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2025-02-01' },
        { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-08-21' },
      ],
      '2026-08-20'
    )
    expect(resigned.result?.lasombud.status).toBe('granted')
  })

  it('a first Verifiera (no row yet) opts in today: an older grant does not count', async () => {
    mockGetConnection.mockResolvedValueOnce(null)
    registryAnswers([{ huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-01-15' }])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({ lasombud: expect.objectContaining({ reason: 'predates_opt_in' }) })
    )
  })

  it('a failed connection read stops the probe: no register call, nothing recorded', async () => {
    mockGetConnection.mockRejectedValueOnce(new Error('skatteverket_company_connections read failed: timeout'))

    await expect(probeCompanyGrants('company-1', ORG)).rejects.toThrow('read failed')
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('a row recorded for another org number opts in today for the new one', async () => {
    mockGetConnection.mockResolvedValueOnce({ id: 'conn-1', org_number: '165599999999', created_at: '2025-01-01T00:00:00Z' })
    registryAnswers([{ huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-01-15' }])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('denied')
  })
})

describe('crm#1762: a grant signed before the opt-in counts for a company proven with BankID', () => {
  // The customer's case: in the app since May, appointed the app at
  // Skatteverket on 19 July, and the connection row was created only on
  // 9 November by the new appoint button. Skatteverket refuses to sign a
  // grant that already stands, so "sign again" was a loop.
  const SIGNED_IN_JULY = { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-07-19' }
  const MOMS_IN_JULY = { huvudman: ORG, roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-07-19' }
  const ROW_IN_NOVEMBER = { id: 'conn-1', org_number: ORG, created_at: '2026-11-09T14:43:38Z' }

  it('proven with BankID: both behörigheter count, nothing to sign again', async () => {
    mockGetConnection.mockResolvedValueOnce(ROW_IN_NOVEMBER)
    proven({ lasombud: '2026-11-09', moms_ombud: '2026-11-09' })
    registryAnswers([SIGNED_IN_JULY, MOMS_IN_JULY])

    const result = await probeCompanyGrants('company-1', ORG, 'user-1')

    expect(mockFindProof).toHaveBeenCalledWith([{ companyId: 'company-1', orgNumber: ORG }], 'lasombud')
    expect(mockFindProof).toHaveBeenCalledWith([{ companyId: 'company-1', orgNumber: ORG }], 'moms_ombud')
    expect(result.lasombud).toEqual({ status: 'granted', detail: expect.any(String) })
    expect(result.momsOmbud).toEqual({ status: 'granted', detail: expect.any(String) })
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        lasombud: expect.objectContaining({ status: 'granted', reason: undefined }),
        momsOmbud: expect.objectContaining({ status: 'granted', reason: undefined }),
      })
    )
  })

  it('no BankID proof (a tenant that typed the number): the earlier grant is still not inherited', async () => {
    mockGetConnection.mockResolvedValueOnce(ROW_IN_NOVEMBER)
    registryAnswers([SIGNED_IN_JULY, MOMS_IN_JULY])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
    expect(result.momsOmbud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
    expect(result.lasombud.detail).toContain('inget BankID-bevis sedan dess')
  })

  it('BankID proof from before the grant was signed proves nothing about it (a seller, an ended accountant)', async () => {
    // Opted in on 1 August, within 30 days of the proof: only its age against the grant fails it.
    mockGetConnection.mockResolvedValueOnce({ ...ROW_IN_NOVEMBER, created_at: '2026-08-01T08:00:00Z' })
    proven({ lasombud: '2026-07-18', moms_ombud: '2026-07-18' })
    registryAnswers([SIGNED_IN_JULY, MOMS_IN_JULY])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
    expect(result.momsOmbud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
  })

  it('BankID proof on the signing day itself counts, within 30 days of the opt-in', async () => {
    const result = await probeViaOmbudsregisterWith([SIGNED_IN_JULY], '2026-08-01', '2026-07-19')
    expect(result.result?.lasombud.status).toBe('granted')
  })

  it('BankID proof more than 30 days before the opt-in speaks for nobody now', async () => {
    const result = await probeViaOmbudsregisterWith([SIGNED_IN_JULY], '2026-11-09', '2026-08-15')
    expect(result.result?.lasombud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
  })

  it('a skattekonto proof counts for läsombud only: the VAT behörighet needs a VAT read', async () => {
    mockGetConnection.mockResolvedValueOnce(ROW_IN_NOVEMBER)
    proven({ lasombud: '2026-11-09' })
    registryAnswers([SIGNED_IN_JULY, MOMS_IN_JULY])

    const result = await probeCompanyGrants('company-1', ORG)

    expect(result.lasombud.status).toBe('granted')
    expect(result.momsOmbud).toMatchObject({ status: 'denied', reason: 'predates_opt_in' })
  })

  it('proof only lifts the signing-day rule: a grant the register does not list is still missing', async () => {
    const result = await probeViaOmbudsregisterWith([SIGNED_IN_JULY], '2026-11-09', '2026-11-09')
    expect(result.result?.lasombud.status).toBe('granted')
    expect(result.result?.momsOmbud).toMatchObject({ status: 'denied' })
    expect(result.result?.momsOmbud.reason).toBeUndefined()
  })

  it('an unreadable proof stops the probe before anything is asked or recorded', async () => {
    mockFindProof.mockRejectedValueOnce(new Error('ownership proof read failed: timeout'))

    await expect(probeCompanyGrants('company-1', ORG)).rejects.toThrow('ownership proof read failed')
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
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

    // Every probe call names the user who asked for the verification.
    expect(mockSkvRequestWithAuth.mock.calls.map((call) => call[3])).toEqual([
      {
        endpoint: 'ombud/autentisieratOmbud',
        companyId: 'company-1',
        userId: 'user-1',
        agRegistreradId: ORG,
        expectJson: true,
      },
      {
        endpoint: 'system-connection/verify/lasombud',
        companyId: 'company-1',
        userId: 'user-1',
        agRegistreradId: ORG,
      },
      expect.objectContaining({
        endpoint: 'system-connection/verify/moms_ombud',
        companyId: 'company-1',
        userId: 'user-1',
        agRegistreradId: ORG,
        okStatuses: [404],
      }),
    ])
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

describe('recordGrantRefusal: a refused system read asks the register before touching the grant (#115)', () => {
  const CONNECTION = { id: 'conn-1', company_id: 'company-1', org_number: ORG, created_at: OPT_IN_AT, last_error: null }
  const LASOMBUD = { huvudman: ORG, roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', ombud: '165590000000', giltigFrom: '2026-07-19' }
  const recorded = () => mockRecordProbeResult.mock.calls.map(([input]) => input)

  beforeEach(() => {
    mockGetConnection.mockResolvedValue(CONNECTION)
  })

  it('withdrawn in the register: that behörighet alone is recorded denied, the other is not asked about', async () => {
    registryAnswers([LASOMBUD])
    await expect(recordGrantRefusal('company-1', 'moms_ombud')).resolves.toBe('withdrawn')
    expect(mockSkvRequestWithAuth.mock.calls[0][2]).toBe(`/ombud/autentisieratOmbud?huvudman=${ORG}`)
    expect(recorded()).toEqual([{
      companyId: 'company-1', environment: 'test', orgNumber: ORG,
      momsOmbud: expect.objectContaining({ status: 'denied' }),
      error: 'OMBUD_GRANT_MISSING',
    }])
    expect(log.error).not.toHaveBeenCalled()
  })

  it('still listed: the grant stays, and the first such refusal is a warning with the same fields, never an error', async () => {
    registryAnswers([LASOMBUD])
    await expect(recordGrantRefusal('company-1', 'lasombud')).resolves.toBe('active')
    expect(recorded()).toEqual([{ companyId: 'company-1', environment: 'test', orgNumber: ORG, error: 'SKV_403_GRANT_ACTIVE' }])
    const reported = log.warn.mock.calls.filter(([message]) => String(message).includes('grant the ombudsregister lists'))
    expect(reported).toEqual([[expect.any(String), { companyId: 'company-1', behorighet: 'lasombud' }]])
    expect(log.error).not.toHaveBeenCalled()
  })

  it('still listed and already recorded: nothing is written or reported again', async () => {
    mockGetConnection.mockResolvedValue({ ...CONNECTION, last_error: 'SKV_403_GRANT_ACTIVE' })
    registryAnswers([LASOMBUD])
    await expect(recordGrantRefusal('company-1', 'lasombud')).resolves.toBe('active')
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('a refusal is news once per stored state', () => {
    expect(grantRefusalIsNew(null)).toBe(true)
    expect(grantRefusalIsNew(undefined)).toBe(true)
    // Another probe result replaced the state: the next refusal is reported again.
    expect(grantRefusalIsNew('OMBUD_GRANT_MISSING')).toBe(true)
    expect(grantRefusalIsNew('SKV_403_GRANT_ACTIVE')).toBe(false)
  })

  it('register unreachable: nothing changes, and no read probe stands in for it', async () => {
    registryUnavailable()
    await expect(recordGrantRefusal('company-1', 'lasombud')).resolves.toBe('unverified')
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(1)
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('roles the register lists but we cannot name: nothing changes', async () => {
    registryAnswers([{ huvudman: ORG, roll: 'ZZ1', rollbeskrivning: 'Okänd roll', giltigFrom: '2026-07-19' }])
    await expect(recordGrantRefusal('company-1', 'lasombud')).resolves.toBe('unverified')
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('a proven grant signed before the opt-in stays active on a refusal (crm#1762)', async () => {
    mockGetConnection.mockResolvedValue({ ...CONNECTION, created_at: '2026-11-09T14:43:38Z' })
    proven({ lasombud: '2026-11-09' })
    registryAnswers([LASOMBUD])
    await expect(recordGrantRefusal('company-1', 'lasombud')).resolves.toBe('active')
    expect(recorded()).toEqual([{ companyId: 'company-1', environment: 'test', orgNumber: ORG, error: 'SKV_403_GRANT_ACTIVE' }])
  })

  it('ownership proof unreadable: nothing changes and the register is not asked', async () => {
    mockFindProof.mockRejectedValueOnce(new Error('ownership proof read failed: timeout'))
    await expect(recordGrantRefusal('company-1', 'lasombud')).resolves.toBe('unverified')
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('no connection row: the register is not asked', async () => {
    mockGetConnection.mockResolvedValue(null)
    await expect(recordGrantRefusal('company-1', 'lasombud')).resolves.toBe('unverified')
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
  })
})
