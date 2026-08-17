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

import { PATCH, DELETE } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const params = { params: Promise.resolve({ id: 'trip-1' }) } as never

type ExistingRow = {
  id: string
  status: string
  vehicle_type: string
  vehicle_registration: string | null
} | null

function supabaseWith(existing: ExistingRow, updated: unknown = { id: 'trip-1' }) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'update', 'delete', 'in']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: existing, error: null }))
  chain.single = vi.fn(() => Promise.resolve({ data: updated, error: null }))
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve)
  return { from: vi.fn(() => chain), chain }
}

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1' } as never,
    supabase: supabase as never,
    error: null,
  } as never)
}

function patchReq(body: unknown) {
  return new Request('https://x.test/api/mileage/trips/trip-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const DRAFT_OWN_CAR: ExistingRow = {
  id: 'trip-1',
  status: 'draft',
  vehicle_type: 'own_car',
  vehicle_registration: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PATCH /api/mileage/trips/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    const res = await PATCH(patchReq({ purpose: 'Nytt ärende' }), params)
    expect(res.status).toBe(401)
  })

  it('returns 404 for a trip outside the company', async () => {
    authed(supabaseWith(null))
    const res = await PATCH(patchReq({ purpose: 'Nytt ärende' }), params)
    expect(res.status).toBe(404)
  })

  it('returns 409 for a booked trip (underlag is immutable)', async () => {
    authed(
      supabaseWith({ ...DRAFT_OWN_CAR, status: 'booked' })
    )
    const res = await PATCH(patchReq({ purpose: 'Nytt ärende' }), params)
    expect(res.status).toBe(409)
  })

  it('rejects assigning an employee outside the company', async () => {
    // maybeSingle serves the trip lookup first, then the employee lookup: the
    // second call finds no company-scoped employee row.
    const supabase = supabaseWith(DRAFT_OWN_CAR)
    const maybeSingle = supabase.chain.maybeSingle as ReturnType<typeof vi.fn>
    maybeSingle
      .mockImplementationOnce(() => Promise.resolve({ data: DRAFT_OWN_CAR, error: null }))
      .mockImplementationOnce(() => Promise.resolve({ data: null, error: null }))
    authed(supabase)
    const res = await PATCH(
      patchReq({ employee_id: '9f8e7d6c-5b4a-4321-8abc-def012345678' }),
      params
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('anställda')
  })

  it('rejects switching to förmånsbil when neither patch nor row has a regnr', async () => {
    authed(supabaseWith(DRAFT_OWN_CAR))
    const res = await PATCH(patchReq({ vehicle_type: 'company_car_fossil' }), params)
    expect(res.status).toBe(400)
  })

  it('allows switching to förmånsbil when the stored row already has a regnr', async () => {
    authed(
      supabaseWith({ ...DRAFT_OWN_CAR, vehicle_registration: 'ABC123' })
    )
    const res = await PATCH(patchReq({ vehicle_type: 'company_car_fossil' }), params)
    expect(res.status).toBe(200)
  })

  it('updates a draft trip', async () => {
    authed(supabaseWith(DRAFT_OWN_CAR, { id: 'trip-1', purpose: 'Nytt ärende' }))
    const res = await PATCH(patchReq({ purpose: 'Nytt ärende' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.purpose).toBe('Nytt ärende')
  })
})

describe('DELETE /api/mileage/trips/[id]', () => {
  it('returns 404 for a trip outside the company', async () => {
    authed(supabaseWith(null))
    const res = await DELETE(
      new Request('https://x.test/api/mileage/trips/trip-1', { method: 'DELETE' }),
      params
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 for a booked trip (BFL retention)', async () => {
    authed(supabaseWith({ ...DRAFT_OWN_CAR, status: 'booked' }))
    const res = await DELETE(
      new Request('https://x.test/api/mileage/trips/trip-1', { method: 'DELETE' }),
      params
    )
    expect(res.status).toBe(409)
  })

  it('deletes a draft trip', async () => {
    authed(supabaseWith(DRAFT_OWN_CAR))
    const res = await DELETE(
      new Request('https://x.test/api/mileage/trips/trip-1', { method: 'DELETE' }),
      params
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.deleted).toBe(true)
  })
})
