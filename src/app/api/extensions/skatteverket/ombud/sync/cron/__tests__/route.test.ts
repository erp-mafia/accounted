/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const mockRegistryGet = vi.fn((_id: string): unknown => ({ id: 'skatteverket' }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: (id: string) => mockRegistryGet(id) },
}))

const mockVerifyCronSecret = vi.fn()
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (...a: unknown[]) => mockVerifyCronSecret(...a),
}))

const mockMode = vi.fn()
const mockConfigured = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/system-auth/config', () => ({
  getSystemAuthMode: () => mockMode(),
  isSystemAuthConfigured: () => mockConfigured(),
}))

vi.mock('@/extensions/general/skatteverket/lib/resolve-auth', () => ({
  currentSkvEnvironment: () => 'test',
}))

const mockListConnections = vi.fn()
const mockRecordProbeResult = vi.fn()
/** Company ids whose claim is held back, and how. Everyone else is 'clear'. */
let heldBack: Record<string, 'unproven' | 'proven_twice'> = {}
const mockStandings = vi.fn(async (claims: Array<{ companyId: string; orgNumber: string }>) =>
  new Map(claims.map((claim) => [claim.companyId, heldBack[claim.companyId] ?? 'clear']))
)
/** Per company id, the latest day a current member proved its number with BankID. */
let proofDays: Record<string, string> = {}
const mockFindProof = vi.fn(async (claims: Array<{ companyId: string; orgNumber: string }>, _key?: string) =>
  new Map(claims.filter((claim) => proofDays[claim.companyId]).map((claim) => [claim.companyId, proofDays[claim.companyId]!]))
)
vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  listConnections: (...a: unknown[]) => mockListConnections(...a),
  recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a),
  getOmbudClaimStandings: (claims: Array<{ companyId: string; orgNumber: string }>) => mockStandings(claims),
  findCompaniesWithOwnershipProof: (claims: Array<{ companyId: string; orgNumber: string }>, key: string) => mockFindProof(claims, key),
}))

const mockListOmbudGrants = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/ombud-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listOmbudGrants: (...a: unknown[]) => mockListOmbudGrants(...a),
  }
})

import { GET } from '../route'

const ENV_KEYS = ['SKATTEVERKET_ENABLED']
let savedEnv: Record<string, string | undefined>

type Status = 'unknown' | 'granted' | 'denied' | 'error'
function connection(
  companyId: string,
  orgNumber: string,
  lasombud: Status = 'granted',
  moms: Status = 'granted',
  status = 'verified',
  // The opt-in: before the 2026-07-19 grants below unless a test says otherwise.
  createdAt = '2026-07-01T08:00:00Z'
) {
  return {
    id: `conn-${companyId}`,
    company_id: companyId,
    environment: 'test',
    org_number: orgNumber,
    status,
    lasombud_status: lasombud,
    moms_ombud_status: moms,
    created_at: createdAt,
  }
}

const SKOL = (huvudman: string) => ({
  huvudman,
  roll: 'skol',
  rollbeskrivning: 'Skattekonto, bara läsbehörighet',
  giltigFrom: '2026-07-19',
})
const MOMS = (huvudman: string) => ({
  huvudman,
  roll: 'momsdeklaration_ombud',
  rollbeskrivning: 'Momsdeklaration, ombud',
  giltigFrom: '2026-07-19',
})

beforeEach(() => {
  vi.clearAllMocks()
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.SKATTEVERKET_ENABLED = 'true'
  mockVerifyCronSecret.mockReturnValue(null)
  mockMode.mockReturnValue('shadow')
  mockConfigured.mockReturnValue(true)
  mockListConnections.mockResolvedValue([])
  mockRecordProbeResult.mockResolvedValue({ id: 'conn' })
  heldBack = {}
  proofDays = {}
  mockListOmbudGrants.mockResolvedValue([])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const request = () => new Request('http://localhost/api/extensions/skatteverket/ombud/sync/cron')
const recordedFor = (companyId: string) =>
  mockRecordProbeResult.mock.calls.map((c) => c[0]).filter((input) => input.companyId === companyId)

describe('GET /api/extensions/skatteverket/ombud/sync/cron', () => {
  it('401 without the cron secret', async () => {
    mockVerifyCronSecret.mockReturnValue(new Response('nope', { status: 401 }))
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(mockListOmbudGrants).not.toHaveBeenCalled()
  })

  it('answers 200 skipped when the skatteverket extension is not in the registry', async () => {
    mockRegistryGet.mockReturnValueOnce(undefined)
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skipped: true, reason: 'extension_disabled', processed: 0 })
    expect(mockListOmbudGrants).not.toHaveBeenCalled()
  })

  it('no-ops when the extension is disabled or system auth is off/unconfigured', async () => {
    process.env.SKATTEVERKET_ENABLED = 'false'
    expect(await (await GET(request())).json()).toMatchObject({ processed: 0 })

    process.env.SKATTEVERKET_ENABLED = 'true'
    mockMode.mockReturnValue('off')
    expect(await (await GET(request())).json()).toMatchObject({ message: 'System auth not active' })

    mockMode.mockReturnValue('on')
    mockConfigured.mockReturnValue(false)
    expect(await (await GET(request())).json()).toMatchObject({ message: 'System auth not active' })
    expect(mockListOmbudGrants).not.toHaveBeenCalled()
  })

  it('502 when the register cannot be read, without touching any row', async () => {
    mockListOmbudGrants.mockRejectedValue(new Error('down'))
    const res = await GET(request())
    expect(res.status).toBe(502)
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('asks the register with the cron-only empty-on-404 option', async () => {
    await GET(request())
    // The whole register is Accounted's own call as ombud: explicitly not
    // audited in the per-company table (the transport logs it instead).
    expect(mockListOmbudGrants).toHaveBeenCalledWith({}, 'ombud_register', { emptyOn404: true })
  })

  it("reads the register on the Swedish day: a grant from today counts on New Year's night", async () => {
    mockListConnections.mockResolvedValue([connection('c-1', '165560000000', 'unknown', 'unknown', 'pending')])
    mockListOmbudGrants.mockResolvedValue([{ ...SKOL('165560000000'), giltigFrom: '2027-01-01' }])
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
    try {
      await GET(request())
      expect(recordedFor('c-1')[0]).toMatchObject({ lasombud: expect.objectContaining({ status: 'granted' }) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('records grants only on rows that already exist (tenant opt-in); a listed huvudman without a row is ignored', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-pending', '165560000000', 'unknown', 'unknown', 'pending'),
      connection('c-partial', '195001011234', 'denied', 'denied', 'pending'),
    ])
    mockListOmbudGrants.mockResolvedValue([
      SKOL('165560000000'),
      MOMS('165560000000'),
      { ...SKOL('195001011234'), roll: 'DEKL', rollbeskrivning: 'Deklarationsombud' },
      MOMS('195001011234'),
      SKOL('165550000000'), // no row for this org number: the twin/unmatched case
    ])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ registryHuvudman: 3, rows: 2, granted: 2, denied: 0, revoked: 0, guardTripped: false })
    expect(mockRecordProbeResult).toHaveBeenCalledTimes(2)
    expect(recordedFor('c-pending')[0]).toMatchObject({
      environment: 'test',
      orgNumber: '165560000000',
      lasombud: expect.objectContaining({ status: 'granted' }),
      momsOmbud: expect.objectContaining({ status: 'granted' }),
    })
    expect(recordedFor('c-partial')[0]).toMatchObject({
      lasombud: expect.objectContaining({ status: 'denied' }),
      momsOmbud: expect.objectContaining({ status: 'granted' }),
    })
    // Never creates a row for the unmatched huvudman.
    expect(mockRecordProbeResult.mock.calls.some((c) => c[0].orgNumber === '165550000000')).toBe(false)
  })

  it('org-number proof: a grant signed before the row opted in is not granted, and says why', async () => {
    mockListConnections.mockResolvedValue([
      // Opted in after the 2026-07-19 grants were signed: a former owner's grants.
      connection('c-late', '165560000000', 'unknown', 'unknown', 'pending', '2026-08-01T09:00:00Z'),
      // Opted in on the signing day: counts.
      connection('c-same-day', '195001011234', 'unknown', 'unknown', 'pending', '2026-07-19T06:00:00Z'),
    ])
    mockListOmbudGrants.mockResolvedValue([
      SKOL('165560000000'),
      MOMS('165560000000'),
      SKOL('195001011234'),
    ])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ granted: 1, denied: 1 })
    expect(recordedFor('c-late')[0]).toMatchObject({
      lasombud: { status: 'denied', reason: 'predates_opt_in' },
      momsOmbud: { status: 'denied', reason: 'predates_opt_in' },
    })
    expect(recordedFor('c-late')[0].lasombud.detail).toContain('signerad före kopplingen 2026-08-01, inget BankID-bevis sedan dess')
    expect(recordedFor('c-same-day')[0]).toMatchObject({
      lasombud: expect.objectContaining({ status: 'granted' }),
      momsOmbud: { status: 'denied', detail: expect.any(String) },
    })
    expect(recordedFor('c-same-day')[0].momsOmbud.reason).toBeUndefined()
  })

  it('crm#1762: a grant signed before the row counts for a company proven with BankID, and proof is read only for such rows', async () => {
    mockListConnections.mockResolvedValue([
      // In the app since May, signed in July, row created by the appoint button in November.
      connection('c-proven', '165560000000', 'denied', 'denied', 'pending', '2026-11-09T14:43:38Z'),
      // Same dates, nobody proved the number: a tenant that typed it.
      connection('c-typed', '165570000000', 'denied', 'denied', 'pending', '2026-11-09T14:43:38Z'),
      // Signed after its opt-in: no proof needed, none read.
      connection('c-fresh', '165580000000', 'unknown', 'unknown', 'pending'),
    ])
    mockListOmbudGrants.mockResolvedValue([
      SKOL('165560000000'), MOMS('165560000000'),
      SKOL('165570000000'), MOMS('165570000000'),
      SKOL('165580000000'),
    ])
    proofDays = { 'c-proven': '2026-11-09', 'c-fresh': '2026-11-09' }

    const body = await (await GET(request())).json()

    // One read per behörighet, each for the rows whose grant of it predates the row.
    expect(mockFindProof).toHaveBeenCalledTimes(2)
    for (const key of ['lasombud', 'moms_ombud']) {
      expect(mockFindProof).toHaveBeenCalledWith(
        [
          { companyId: 'c-proven', orgNumber: '165560000000' },
          { companyId: 'c-typed', orgNumber: '165570000000' },
        ],
        key
      )
    }
    expect(recordedFor('c-proven')[0]).toMatchObject({
      lasombud: { status: 'granted' },
      momsOmbud: { status: 'granted' },
    })
    expect(recordedFor('c-proven')[0].lasombud.reason).toBeUndefined()
    // Already denied for the same reason: nothing to write.
    expect(recordedFor('c-typed')).toEqual([])
    expect(body).toMatchObject({ granted: 2, unchanged: 1 })
  })

  it('a held-back claim costs no proof read and stays frozen, proof or not', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-held', '165560000000', 'denied', 'denied', 'pending', '2026-11-09T14:43:38Z'),
    ])
    mockListOmbudGrants.mockResolvedValue([SKOL('165560000000'), MOMS('165560000000')])
    heldBack = { 'c-held': 'unproven' }
    proofDays = { 'c-held': '2026-11-09' }

    const body = await (await GET(request())).json()

    expect(mockFindProof).toHaveBeenCalledWith([], 'lasombud')
    expect(mockFindProof).toHaveBeenCalledWith([], 'moms_ombud')
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
    expect(body).toMatchObject({ contested: 1, granted: 0 })
  })

  it('an unreadable ownership proof fails the run before any row is written', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-proven', '165560000000', 'granted', 'granted', 'verified', '2026-11-09T14:43:38Z'),
    ])
    mockListOmbudGrants.mockResolvedValue([SKOL('165560000000'), MOMS('165560000000')])
    mockFindProof.mockRejectedValueOnce(new Error('ownership proof read failed: timeout'))

    const res = await GET(request())

    expect(res.status).toBe(500)
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('skips rows the tenant revoked locally even though the grant still stands at Skatteverket', async () => {
    mockListConnections.mockResolvedValue([connection('c-off', '165560000000', 'unknown', 'unknown', 'revoked')])
    mockListOmbudGrants.mockResolvedValue([SKOL('165560000000'), MOMS('165560000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ rows: 0 })
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('leaves unchanged rows alone, records denial once for a never-listed pending row, downgrades one revoked-at-SKV row', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-keep', '165560000000'),
      connection('c-keep2', '165570000000'),
      connection('c-keep3', '165580000000'),
      connection('c-gone', '165590000000'),
      connection('c-never', '165500000000', 'denied', 'denied', 'pending'),
      connection('c-fresh', '165510000000', 'unknown', 'unknown', 'pending'),
    ])
    mockListOmbudGrants.mockResolvedValue([
      SKOL('165560000000'), MOMS('165560000000'),
      SKOL('165570000000'), MOMS('165570000000'),
      SKOL('165580000000'), MOMS('165580000000'),
    ])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ unchanged: 4, revoked: 1, denied: 1, granted: 0, guardTripped: false })
    expect(mockRecordProbeResult).toHaveBeenCalledTimes(2)
    expect(recordedFor('c-gone')[0]).toMatchObject({
      orgNumber: '165590000000',
      lasombud: { status: 'denied', detail: expect.stringContaining('huvudman saknas') },
      momsOmbud: { status: 'denied' },
    })
    // The deep-link row nobody signed yet: written once as "Saknas", not left "Inte verifierad".
    expect(recordedFor('c-fresh')[0]).toMatchObject({ lasombud: { status: 'denied' }, momsOmbud: { status: 'denied' } })
    expect(recordedFor('c-never')).toHaveLength(0)
  })

  it('a failed upsert is counted once and never turns into a downgrade', async () => {
    mockListConnections.mockResolvedValue([connection('c-1', '165560000000', 'unknown', 'unknown', 'pending')])
    mockListOmbudGrants.mockResolvedValue([SKOL('165560000000')])
    mockRecordProbeResult.mockResolvedValue(null)

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ failed: 1, revoked: 0, granted: 0 })
    expect(mockRecordProbeResult).toHaveBeenCalledTimes(1)
  })

  it('empty-register guard: no grants while rows exist downgrades nothing', async () => {
    mockListOmbudGrants.mockResolvedValue([])
    mockListConnections.mockResolvedValue([connection('c-1', '165560000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ registryHuvudman: 0, revoked: 0, skipped: 1, guardTripped: true, guardReason: 'empty_register' })
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('mass-downgrade guard: a run that would deny most granted rows applies no downgrade, but still records upgrades', async () => {
    // Four granted rows; the register (say, with a mistyped pinned code) lists
    // only one of them, plus a pending row that did get its grant.
    mockListConnections.mockResolvedValue([
      connection('c-1', '165510000000'),
      connection('c-2', '165520000000'),
      connection('c-3', '165530000000'),
      connection('c-4', '165540000000'),
      connection('c-new', '165550000000', 'unknown', 'unknown', 'pending'),
    ])
    mockListOmbudGrants.mockResolvedValue([SKOL('165510000000'), MOMS('165510000000'), SKOL('165550000000'), MOMS('165550000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ guardTripped: true, guardReason: 'mass_downgrade', revoked: 0, skipped: 3, granted: 1, unchanged: 1 })
    expect(mockRecordProbeResult).toHaveBeenCalledTimes(1)
    expect(recordedFor('c-new')[0]).toMatchObject({ lasombud: { status: 'granted' } })
  })

  it('a held-back claim (contested, not the one proven with BankID) is never granted, and an existing grant on it is withdrawn', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-victim', '165560000000'), // verified before the twin appeared
      connection('c-twin', '165560000000', 'unknown', 'unknown', 'pending'),
      connection('c-clear', '165570000000', 'unknown', 'unknown', 'pending'),
    ])
    heldBack = { 'c-victim': 'unproven', 'c-twin': 'unproven' }
    mockListOmbudGrants.mockResolvedValue([SKOL('165560000000'), MOMS('165560000000'), SKOL('165570000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ contested: 2, revoked: 1, granted: 1, guardTripped: false })
    expect(mockStandings).toHaveBeenCalledWith([
      { companyId: 'c-victim', orgNumber: '165560000000' },
      { companyId: 'c-twin', orgNumber: '165560000000' },
      { companyId: 'c-clear', orgNumber: '165570000000' },
    ])
    expect(mockRecordProbeResult).toHaveBeenCalledTimes(2)
    expect(recordedFor('c-clear')[0]).toMatchObject({ lasombud: { status: 'granted' } })
    expect(recordedFor('c-victim')[0]).toMatchObject({
      lasombud: { status: 'denied', detail: expect.stringContaining('fler än ett företag') },
      momsOmbud: { status: 'denied' },
    })
    expect(recordedFor('c-twin')).toHaveLength(0)
  })

  it('on a contested number the one claimant proven with BankID is reconciled like any other row; the unproven twin is not', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-owner', '165560000000', 'unknown', 'unknown', 'pending'),
      connection('c-stranger', '165560000000', 'unknown', 'unknown', 'pending'),
    ])
    heldBack = { 'c-stranger': 'unproven' }
    mockListOmbudGrants.mockResolvedValue([SKOL('165560000000'), MOMS('165560000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ contested: 1, granted: 1, revoked: 0 })
    expect(recordedFor('c-owner')[0]).toMatchObject({ lasombud: { status: 'granted' }, momsOmbud: { status: 'granted' } })
    expect(recordedFor('c-stranger')).toHaveLength(0)
  })

  it('two claimants proven on one number: both held back, a grant either held is withdrawn', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-real', '165560000000'),
      connection('c-copy', '165560000000', 'unknown', 'unknown', 'pending'),
    ])
    heldBack = { 'c-real': 'proven_twice', 'c-copy': 'proven_twice' }
    mockListOmbudGrants.mockResolvedValue([SKOL('165560000000'), MOMS('165560000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ contested: 2, revoked: 1, granted: 0 })
    expect(recordedFor('c-real')[0]).toMatchObject({ lasombud: { status: 'denied' }, momsOmbud: { status: 'denied' } })
    expect(recordedFor('c-copy')).toHaveLength(0)
  })

  it('a huvudman listed with only unrecognised role codes is neither granted nor denied (pinning problem)', async () => {
    mockListConnections.mockResolvedValue([connection('c-1', '165560000000')])
    mockListOmbudGrants.mockResolvedValue([
      { huvudman: '165560000000', roll: 'ZZ9', rollbeskrivning: 'Läsombud, juridisk person', giltigFrom: '2026-07-19' },
    ])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ unrecognized: 1, revoked: 0, denied: 0, guardTripped: false })
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('mass-downgrade guard needs at least three planned downgrades', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-1', '165510000000'),
      connection('c-2', '165520000000'),
    ])
    mockListOmbudGrants.mockResolvedValue([SKOL('165510000000'), MOMS('165510000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ guardTripped: false, revoked: 1 })
  })
})
