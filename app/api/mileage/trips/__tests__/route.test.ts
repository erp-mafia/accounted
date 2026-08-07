import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/mileage/mileage-service', () => ({
  listTrips: vi.fn(),
  createTrip: vi.fn(),
}))

import { GET, POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { createTrip, listTrips } from '@/lib/mileage/mileage-service'

const params = { params: Promise.resolve({}) } as never

function authed() {
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1' } as never,
    supabase: {} as never,
    error: null,
  } as never)
}

function unauthed() {
  vi.mocked(requireAuth).mockResolvedValue({
    user: null,
    supabase: null,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  } as never)
}

const VALID_TRIP = {
  trip_date: '2026-05-10',
  distance_km: 32,
  from_location: 'Kontoret',
  to_location: 'Kunden',
  purpose: 'Kundbesök',
}

function postReq(body: unknown) {
  return new Request('https://x.test/api/mileage/trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/mileage/trips', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await GET(new Request('https://x.test/api/mileage/trips'), params)
    expect(res.status).toBe(401)
  })

  it('returns the trip list and forwards filters', async () => {
    authed()
    vi.mocked(listTrips).mockResolvedValue([{ id: 't1' }] as never)
    const res = await GET(
      new Request('https://x.test/api/mileage/trips?from=2026-05-01&to=2026-05-31&status=draft'),
      params
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(vi.mocked(listTrips).mock.calls[0][2]).toMatchObject({
      from: '2026-05-01',
      to: '2026-05-31',
      status: 'draft',
    })
  })
})

describe('POST /api/mileage/trips', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await POST(postReq(VALID_TRIP), params)
    expect(res.status).toBe(401)
  })

  it('returns 400 on invalid body (missing purpose, negative km)', async () => {
    authed()
    const res = await POST(
      postReq({ trip_date: '2026-05-10', distance_km: -5, from_location: 'A', to_location: 'B' }),
      params
    )
    expect(res.status).toBe(400)
    expect(createTrip).not.toHaveBeenCalled()
  })

  it('rejects a förmånsbil trip without vehicle_registration', async () => {
    authed()
    const res = await POST(
      postReq({ ...VALID_TRIP, vehicle_type: 'company_car_fossil' }),
      params
    )
    expect(res.status).toBe(400)
    expect(createTrip).not.toHaveBeenCalled()
  })

  it('rejects odometer_end <= odometer_start', async () => {
    authed()
    const res = await POST(
      postReq({ ...VALID_TRIP, odometer_start: 1032, odometer_end: 1000 }),
      params
    )
    expect(res.status).toBe(400)
  })

  it('creates the trip and returns 201', async () => {
    authed()
    vi.mocked(createTrip).mockResolvedValue({ id: 't1', status: 'draft' } as never)
    const res = await POST(postReq(VALID_TRIP), params)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.id).toBe('t1')
    expect(vi.mocked(createTrip).mock.calls[0][1]).toBe('company-1')
    expect(vi.mocked(createTrip).mock.calls[0][2]).toBe('user-1')
  })
})
