import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/sandbox/guard', () => ({ guardSandbox: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/mileage/distance', () => ({ fetchDistanceSuggestion: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { fetchDistanceSuggestion } from '@/lib/mileage/distance'

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

function req(query: string) {
  return new Request(`https://x.test/api/mileage/distance${query}`)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/mileage/distance', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await GET(req('?from=A%20stad&to=B%20stad'), params)
    expect(res.status).toBe(401)
    expect(fetchDistanceSuggestion).not.toHaveBeenCalled()
  })

  it('returns 400 when from/to are missing or too short', async () => {
    authed()
    expect((await GET(req('?from=Storgatan'), params)).status).toBe(400)
    expect((await GET(req('?from=A&to=B'), params)).status).toBe(400)
    expect(fetchDistanceSuggestion).not.toHaveBeenCalled()
  })

  it('returns the suggestion on a resolvable route', async () => {
    authed()
    vi.mocked(fetchDistanceSuggestion).mockResolvedValue({
      distance_km: 47.3,
      from_label: 'Växjö, Sverige',
      to_label: 'Alvesta, Sverige',
    })
    const res = await GET(req('?from=V%C3%A4xj%C3%B6&to=Alvesta'), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.distance_km).toBe(47.3)
    expect(vi.mocked(fetchDistanceSuggestion)).toHaveBeenCalledWith('Växjö', 'Alvesta')
  })

  it('returns data: null when no suggestion could be resolved', async () => {
    authed()
    vi.mocked(fetchDistanceSuggestion).mockResolvedValue(null)
    const res = await GET(req('?from=hemma&to=jobbet'), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toBeNull()
  })
})
