/**
 * Skatteverket helpers through the v1 door of the operation registry
 * (src/lib/operations/skatteverket-helpers.ts via lib/operations/v1.ts):
 *   POST /api/v1/companies/:companyId/skatteverket/agi/validate-huvuduppgift
 *   POST /api/v1/companies/:companyId/skatteverket/agi/validate-individuppgift
 *   POST /api/v1/companies/:companyId/skattekonto/sync
 *
 * Core never imports the skatteverket extension: the call goes through the
 * registry-resolved services (lib/skatteverket/extension-actions.ts), mocked
 * here. Under test: the extension-absent answer, input validation before
 * anything reaches Skatteverket, the failure mapping, and a sync dry run that
 * never calls Skatteverket.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const registryGet = vi.fn()
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: (...args: unknown[]) => registryGet(...args) } }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as validateHu } from '../validate-huvuduppgift/route'
import { POST as validateIu } from '../validate-individuppgift/route'
import { POST as syncSkattekonto } from '../../../skattekonto/sync/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

/** A client that answers the door's membership read; every other read finds nothing. */
function client() {
  const chainFor = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve(table === 'company_members' ? OWNER : { data: null, error: null })
          }
          return () => chainFor(table)
        },
      },
    )
  return { from: vi.fn((table: string) => chainFor(table)), rpc: vi.fn() }
}

function request(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const HU = { agRegistreradId: '165560000167', redovisningsPeriod: '202609', summaSkatteavdr: 8200 }
const IU = {
  agRegistreradId: '165560000167',
  redovisningsPeriod: '202609',
  betalningsmottagarId: '198001019876',
  specifikationsnummer: 1,
  kontantErsattningUlagAG: 35000,
  avdrPrelSkatt: 8200,
}

const services = {
  validateAgiUppgift: vi.fn(),
  syncSkattekontoNow: vi.fn(),
  previewSkattekontoSync: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  registryGet.mockReturnValue({ services })
  mockServiceClient.mockReturnValue(client())
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['compliance:read', 'transactions:write'],
    mode: 'live',
  })
})

describe('POST /skatteverket/agi/validate-huvuduppgift', () => {
  const post = (body: unknown) => validateHu(request(`${BASE}/skatteverket/agi/validate-huvuduppgift`, body), params)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await post(HU)).status).toBe(401)
  })

  it('403 without compliance:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await post(HU)).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a payload outside the v1.7 schema, before Skatteverket is called', async () => {
    const res = await post({ ...HU, redovisningsPeriod: '201701' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(services.validateAgiUppgift).not.toHaveBeenCalled()
  })

  it('503 EXTENSION_DISABLED when the skatteverket extension is not registered', async () => {
    registryGet.mockReturnValue(undefined)
    const res = await post(HU)
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('EXTENSION_DISABLED')
  })

  it('answers Skatteverket\'s kontrollsvar', async () => {
    services.validateAgiUppgift.mockResolvedValue({
      ok: true,
      data: { status: 'INFO', fel: [{ status: 'INFO', felmeddelande: 'Summa skatteavdrag avviker.' }, { status: 'OK' }] },
    })
    const res = await post(HU)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      uppgift: 'huvuduppgift',
      status: 'INFO',
      fel: [
        { status: 'INFO', felmeddelande: 'Summa skatteavdrag avviker.' },
        { status: 'OK', felmeddelande: null },
      ],
    })
    expect(services.validateAgiUppgift).toHaveBeenCalledWith(expect.anything(), 'user-1', COMPANY_ID, {
      uppgift: 'huvuduppgift',
      payload: HU,
    })
  })

  it('maps a missing connection to 401 SKATTEVERKET_NOT_CONNECTED with the service\'s sentence', async () => {
    services.validateAgiUppgift.mockResolvedValue({
      ok: false,
      code: 'SKATTEVERKET_NOT_CONNECTED',
      http_status: 401,
      error: 'Inte ansluten till Skatteverket.',
      details: { skv_code: 'NOT_CONNECTED' },
    })
    const res = await post(HU)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('SKATTEVERKET_NOT_CONNECTED')
    expect(body.error.details.reason).toBe('Inte ansluten till Skatteverket.')
  })
})

describe('POST /skatteverket/agi/validate-individuppgift', () => {
  const post = (body: unknown) => validateIu(request(`${BASE}/skatteverket/agi/validate-individuppgift`, body), params)

  it('refuses forstaAnstalld together with vaxaStod (400) without calling Skatteverket', async () => {
    const res = await post({ ...IU, forstaAnstalld: true, vaxaStod: true })
    expect(res.status).toBe(400)
    expect(services.validateAgiUppgift).not.toHaveBeenCalled()
  })

  it('validates an individuppgift', async () => {
    services.validateAgiUppgift.mockResolvedValue({ ok: true, data: { status: 'OK', fel: [] } })
    const res = await post(IU)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ uppgift: 'individuppgift', status: 'OK', fel: [] })
  })
})

describe('POST /skattekonto/sync', () => {
  const post = (query = '') => syncSkattekonto(request(`${BASE}/skattekonto/sync${query}`), params)

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['compliance:read'], mode: 'live' })
    expect((await post()).status).toBe(403)
  })

  it('a dry run checks the connection locally and never calls Skatteverket', async () => {
    services.previewSkattekontoSync.mockResolvedValue({
      ok: true,
      data: { auth_source: 'user', last_synced_at: '2026-09-26T07:00:00.000Z' },
    })
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ auth_source: 'user', last_synced_at: '2026-09-26T07:00:00.000Z' })
    expect(services.syncSkattekontoNow).not.toHaveBeenCalled()
  })

  it('a dry run surfaces an expired connection before anything is sent', async () => {
    services.previewSkattekontoSync.mockResolvedValue({
      ok: false,
      code: 'SKATTEVERKET_NOT_CONNECTED',
      http_status: 401,
      error: 'Anslutningen mot Skatteverket har gått ut.',
      details: { skv_code: 'SESSION_EXPIRED' },
    })
    const res = await post('?dry_run=true')
    expect(res.status).toBe(401)
    expect(services.syncSkattekontoNow).not.toHaveBeenCalled()
  })

  it('syncs and answers the counts and saldo', async () => {
    services.syncSkattekontoNow.mockResolvedValue({
      ok: true,
      data: { booked: 3, upcoming: 1, skipped: 0, saldoSkatteverket: -1240, saldoKronofogden: 0, syncedAt: '2026-09-26T08:00:00.000Z' },
    })
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      booked: 3,
      upcoming: 1,
      skipped: 0,
      saldo_skatteverket: -1240,
      saldo_kronofogden: 0,
      synced_at: '2026-09-26T08:00:00.000Z',
    })
  })

  it('403 SKATTEVERKET_CAPABILITY_BLOCKED without the paid capability', async () => {
    services.syncSkattekontoNow.mockResolvedValue({
      ok: false,
      code: 'SKATTEVERKET_CAPABILITY_BLOCKED',
      http_status: 403,
      error: 'Den här funktionen kräver en betald prenumeration.',
    })
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('SKATTEVERKET_CAPABILITY_BLOCKED')
  })
})
