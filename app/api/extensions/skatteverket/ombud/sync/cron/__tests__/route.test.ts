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

const mockFrom = vi.fn()
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => ({ from: (...a: unknown[]) => mockFrom(...a) }),
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

const ENV_KEYS = ['SKATTEVERKET_ENABLED', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
let savedEnv: Record<string, string | undefined>

function companySettings(rows: Array<{ company_id: string; org_number: string; entity_type: string }>) {
  const builder: any = {}
  for (const m of ['select', 'not', 'order']) builder[m] = vi.fn(() => builder)
  builder.range = vi.fn(async () => ({ data: rows, error: null }))
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'company_settings') throw new Error(`unexpected table ${table}`)
    return builder
  })
}

function connection(companyId: string, orgNumber: string, lasombud = 'granted', moms = 'granted') {
  return {
    id: `conn-${companyId}`,
    company_id: companyId,
    environment: 'test',
    org_number: orgNumber,
    status: 'verified',
    lasombud_status: lasombud,
    moms_ombud_status: moms,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.SKATTEVERKET_ENABLED = 'true'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  mockVerifyCronSecret.mockReturnValue(null)
  mockMode.mockReturnValue('shadow')
  mockConfigured.mockReturnValue(true)
  mockListConnections.mockResolvedValue([])
  mockRecordProbeResult.mockResolvedValue({ id: 'conn' })
  mockListOmbudGrants.mockResolvedValue([])
  companySettings([])
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

  it('records granted/denied per matched company, creating rows nobody verified by hand', async () => {
    companySettings([
      { company_id: 'c-ab', org_number: '556000-0000', entity_type: 'aktiebolag' },
      { company_id: 'c-ef', org_number: '5001011234', entity_type: 'enskild_firma' },
      { company_id: 'c-none', org_number: '5590000000', entity_type: 'aktiebolag' },
    ])
    mockListOmbudGrants.mockResolvedValue([
      { huvudman: '165560000000', roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-07-19' },
      { huvudman: '165560000000', roll: 'MOMS', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-07-19' },
      { huvudman: '195001011234', roll: 'DEKL', rollbeskrivning: 'Deklarationsombud', giltigFrom: '2026-07-19' },
      { huvudman: '165550000000', roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-07-19' },
    ])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ registryHuvudman: 3, granted: 1, denied: 1, unmatched: 1, revoked: 0, guardTripped: false })
    expect(mockRecordProbeResult).toHaveBeenCalledTimes(2)
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c-ab',
        environment: 'test',
        orgNumber: '165560000000',
        lasombud: expect.objectContaining({ status: 'granted' }),
        momsOmbud: expect.objectContaining({ status: 'granted' }),
      }),
    )
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c-ef',
        orgNumber: '195001011234',
        lasombud: expect.objectContaining({ status: 'denied' }),
        momsOmbud: expect.objectContaining({ status: 'denied' }),
      }),
    )
  })

  it('downgrades rows the register no longer lists, but leaves already-denied rows alone', async () => {
    companySettings([
      { company_id: 'c-keep', org_number: '5560000000', entity_type: 'aktiebolag' },
      { company_id: 'c-gone', org_number: '5590000000', entity_type: 'aktiebolag' },
      { company_id: 'c-down', org_number: '5580000000', entity_type: 'aktiebolag' },
    ])
    mockListOmbudGrants.mockResolvedValue([
      { huvudman: '165560000000', roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-07-19' },
    ])
    mockListConnections.mockResolvedValue([
      connection('c-keep', '165560000000'),
      connection('c-gone', '165590000000'),
      connection('c-down', '165580000000', 'denied', 'denied'),
    ])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ granted: 1, revoked: 1, guardTripped: false })
    const revokedCall = mockRecordProbeResult.mock.calls.find((c) => c[0].companyId === 'c-gone')
    expect(revokedCall?.[0]).toMatchObject({
      orgNumber: '165590000000',
      lasombud: { status: 'denied' },
      momsOmbud: { status: 'denied' },
    })
    expect(mockRecordProbeResult.mock.calls.some((c) => c[0].companyId === 'c-down')).toBe(false)
  })

  it('mass-revocation guard: an empty register with local rows downgrades nothing', async () => {
    mockListOmbudGrants.mockResolvedValue([])
    mockListConnections.mockResolvedValue([connection('c-1', '165560000000')])

    const body = await (await GET(request())).json()

    expect(body).toMatchObject({ registryHuvudman: 0, revoked: 0, guardTripped: true })
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })
})
