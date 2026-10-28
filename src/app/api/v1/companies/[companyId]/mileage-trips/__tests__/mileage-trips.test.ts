/**
 * Körjournal (mileage trips) through the v1 door of the operation registry
 * (src/lib/operations/mileage-trips.ts via lib/operations/v1.ts):
 *   GET  /api/v1/companies/:companyId/mileage-trips
 *   POST /api/v1/companies/:companyId/mileage-trips
 *
 * The rules under test: the company filter and the km sums on the list, the
 * förmånsbil registration rule and the employee tenancy check answered as
 * structured codes (never a 500), and a dry run that writes nothing.
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
const loadPayrollConfigMock = vi.fn()
vi.mock('@/lib/salary/payroll-config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salary/payroll-config')>('@/lib/salary/payroll-config')
  return { ...actual, loadPayrollConfig: (...args: unknown[]) => loadPayrollConfigMock(...args) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listTrips, POST as createTrip } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that also records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc: vi.fn(() => buildChain('rpc')) }
}

const wroteTrips = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => c.table === 'mileage_trips' && ['insert', 'update', 'upsert', 'delete'].includes(c.method))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TRIP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TRIP_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMPLOYEE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const JE_ID = '99999999-9999-4999-8999-999999999999'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/mileage-trips`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function tripRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRIP_ID,
    company_id: COMPANY_ID,
    user_id: 'user-1',
    employee_id: null,
    trip_date: '2026-10-14',
    vehicle_type: 'own_car',
    vehicle_registration: null,
    odometer_start: 48210,
    odometer_end: 48352,
    distance_km: '142.0',
    from_location: 'Kontoret, Uppsala',
    to_location: 'Kund AB, Stockholm',
    purpose: 'Kundmöte',
    visited: 'Kund AB',
    is_round_trip: true,
    status: 'draft',
    journal_entry_id: null,
    salary_run_id: null,
    notes: null,
    created_via: 'manual',
    created_at: '2026-10-14T16:02:00.000Z',
    updated_at: '2026-10-14T16:02:00.000Z',
    ...overrides,
  }
}

const validTrip = {
  trip_date: '2026-10-14',
  distance_km: 142,
  from_location: 'Kontoret, Uppsala',
  to_location: 'Kund AB, Stockholm',
  purpose: 'Kundmöte',
  visited: 'Kund AB',
  is_round_trip: true,
  odometer_start: 48210,
  odometer_end: 48352,
}

beforeEach(() => {
  vi.clearAllMocks()
  loadPayrollConfigMock.mockResolvedValue({
    milersattningEgenBil: 25,
    milersattningFormansbilFossil: 12,
    milersattningFormansbilEl: 9.5,
  })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'iPhone',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/mileage-trips', () => {
  const list = (query = '') => listTrips(request(`${BASE}${query}`), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await list()).status).toBe(401)
  })

  it('403 without payroll:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await list()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR on an unknown status, a malformed date or a non-uuid employee_id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const status = await list('?status=open')
    expect(status.status).toBe(400)
    expect((await status.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await list('?from=14-10-2026')).status).toBe(400)
    expect((await list('?employee_id=nope')).status).toBe(400)
  })

  it('lists the company\'s trips with numeric km, qualified ids, the filters and the km sums', async () => {
    const booked = tripRow({ id: TRIP_B, distance_km: '10.3', status: 'booked', journal_entry_id: JE_ID })
    const client = makeClient({
      company_members: MEMBER,
      mileage_trips: { data: [tripRow({ distance_km: '0.1' }), tripRow({ distance_km: '0.2' }), booked], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await list(`?from=2026-10-01&to=2026-10-31&status=draft&employee_id=${EMPLOYEE_ID}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.mileage_trips).toHaveLength(3)
    expect(body.data.mileage_trips[0]).toEqual({
      mileage_trip_id: TRIP_ID,
      trip_date: '2026-10-14',
      vehicle_type: 'own_car',
      vehicle_registration: null,
      odometer_start: 48210,
      odometer_end: 48352,
      distance_km: 0.1,
      from_location: 'Kontoret, Uppsala',
      to_location: 'Kund AB, Stockholm',
      purpose: 'Kundmöte',
      visited: 'Kund AB',
      is_round_trip: true,
      employee_id: null,
      status: 'draft',
      journal_entry_id: null,
      created_at: '2026-10-14T16:02:00.000Z',
    })
    // 0.1 + 0.2 + 10.3 drifts in floats; the sums are rounded.
    expect(body.data.total_km).toBe(10.6)
    expect(body.data.draft_km).toBe(0.3)
    expect(client.calls).toContainEqual({ table: 'mileage_trips', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(client.calls).toContainEqual({ table: 'mileage_trips', method: 'gte', args: ['trip_date', '2026-10-01'] })
    expect(client.calls).toContainEqual({ table: 'mileage_trips', method: 'lte', args: ['trip_date', '2026-10-31'] })
    expect(client.calls).toContainEqual({ table: 'mileage_trips', method: 'eq', args: ['status', 'draft'] })
    expect(client.calls).toContainEqual({ table: 'mileage_trips', method: 'eq', args: ['employee_id', EMPLOYEE_ID] })
  })

  it('answers an empty log with zero sums', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, mileage_trips: { data: [], error: null } }))
    const res = await list()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ mileage_trips: [], total_km: 0, draft_km: 0 })
  })
})

describe('POST /api/v1/companies/:companyId/mileage-trips', () => {
  const post = (body: unknown, query = '') =>
    createTrip(request(`${BASE}${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post(validTrip)).status).toBe(401)
  })

  it('403 without payroll:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['payroll:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post(validTrip)).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a missing purpose, a non-positive distance or odometer readings out of order', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    const { purpose: _omit, ...noPurpose } = validTrip
    const res = await post(noPurpose)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await post({ ...validTrip, distance_km: 0 })).status).toBe(400)
    expect((await post({ ...validTrip, odometer_start: 500, odometer_end: 400 })).status).toBe(400)
    expect(wroteTrips(client)).toBe(false)
  })

  it('400 VALIDATION_ERROR on vehicle_registration for a förmånsbil trip without one, and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ ...validTrip, vehicle_type: 'company_car_fossil', vehicle_registration: '  ' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify(body.error)).toContain('vehicle_registration')
    expect(wroteTrips(client)).toBe(false)
  })

  it('404 EMPLOYEE_NOT_FOUND for an employee outside the company, not a 500', async () => {
    const client = makeClient({ company_members: MEMBER, employees: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ ...validTrip, employee_id: EMPLOYEE_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('EMPLOYEE_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'employees', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(wroteTrips(client)).toBe(false)
  })

  it('logs the trip as a draft for the key\'s user and answers it (201)', async () => {
    const client = makeClient({
      company_members: MEMBER,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
      mileage_trips: { data: tripRow({ employee_id: EMPLOYEE_ID, vehicle_type: 'company_car_electric', vehicle_registration: 'ABC123' }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({
      ...validTrip,
      employee_id: EMPLOYEE_ID,
      vehicle_type: 'company_car_electric',
      vehicle_registration: ' ABC123 ',
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({
      mileage_trip_id: TRIP_ID,
      employee_id: EMPLOYEE_ID,
      vehicle_type: 'company_car_electric',
      vehicle_registration: 'ABC123',
      distance_km: 142,
      status: 'draft',
    })
    expect(body.data.id).toBeUndefined()
    const insert = client.calls.find((c) => c.table === 'mileage_trips' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({
      company_id: COMPANY_ID,
      user_id: 'user-1',
      employee_id: EMPLOYEE_ID,
      vehicle_type: 'company_car_electric',
      vehicle_registration: 'ABC123',
      distance_km: 142,
      purpose: 'Kundmöte',
    })
  })

  it('a dry run previews the trip and its schablon allowance and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    const res = await post(validTrip, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      trip_date: '2026-10-14',
      vehicle_type: 'own_car',
      distance_km: 142,
      status: 'draft',
      rate_per_mil: 25,
      estimated_allowance_sek: 355,
    })
    expect(wroteTrips(client)).toBe(false)
  })

  it('a dry run still answers when the year has no payroll rates', async () => {
    loadPayrollConfigMock.mockRejectedValue(new Error('no config for 2026'))
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await post(validTrip, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ rate_per_mil: null, estimated_allowance_sek: null })
  })
})
