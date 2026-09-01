/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
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
vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  listConnections: (...a: unknown[]) => mockListConnections(...a),
  recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a),
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
  status = 'verified'
) {
  return {
    id: `conn-${companyId}`,
    company_id: companyId,
    environment: 'test',
    org_number: orgNumber,
    status,
    lasombud_status: lasombud,
    moms_ombud_status: moms,
  }
}

const JLO = (huvudman: string) => ({
  huvudman,
  roll: 'JLO',
  rollbeskrivning: 'Juridiskt läsombud',
  giltigFrom: '2026-07-19',
})
const MOMS = (huvudman: string) => ({
  huvudman,
  roll: 'MOMS',
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

  it('503 EXTENSION_DISABLED when the skatteverket extension is not in the registry', async () => {
    mockRegistryGet.mockReturnValueOnce(undefined)
    const res = await GET(request())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'EXTENSION_DISABLED' })
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
    expect(mockListOmbudGrants).toHaveBeenCalledWith({}, { emptyOn404: true })
  })

  it('records grants only on rows that already exist (tenant opt-in); a listed huvudman without a row is ignored', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-pending', '165560000000', 'unknown', 'unknown', 'pending'),
      connection('c-partial', '195001011234', 'denied', 'denied', 'pending'),
    ])
    mockListOmbudGrants.mockResolvedValue([
      JLO('165560000000'),
      MOMS('165560000000'),
      { ...JLO('195001011234'), roll: 'DEKL', rollbeskrivning: 'Deklarationsombud' },
      MOMS('195001011234'),
      JLO('165550000000'), // no row for this org number: the twin/unmatched case
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

  it('skips rows the tenant revoked locally even though the grant still stands at Skatteverket', async () => {
    mockListConnections.mockResolvedValue([connection('c-off', '165560000000', 'unknown', 'unknown', 'revoked')])
    mockListOmbudGrants.mockResolvedValue([JLO('165560000000'), MOMS('165560000000')])

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
      JLO('165560000000'), MOMS('165560000000'),
      JLO('165570000000'), MOMS('165570000000'),
      JLO('165580000000'), MOMS('165580000000'),
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
    mockListOmbudGrants.mockResolvedValue([JLO('165560000000')])
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
    mockListOmbudGrants.mockResolvedValue([JLO('165510000000'), MOMS('165510000000'), JLO('165550000000'), MOMS('165550000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ guardTripped: true, guardReason: 'mass_downgrade', revoked: 0, skipped: 3, granted: 1, unchanged: 1 })
    expect(mockRecordProbeResult).toHaveBeenCalledTimes(1)
    expect(recordedFor('c-new')[0]).toMatchObject({ lasombud: { status: 'granted' } })
  })

  it('mass-downgrade guard needs at least three planned downgrades', async () => {
    mockListConnections.mockResolvedValue([
      connection('c-1', '165510000000'),
      connection('c-2', '165520000000'),
    ])
    mockListOmbudGrants.mockResolvedValue([JLO('165510000000'), MOMS('165510000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ guardTripped: false, revoked: 1 })
  })
})
