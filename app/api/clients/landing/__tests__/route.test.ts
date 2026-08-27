import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const resolveBrandByHostMock = vi.fn()
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandByHost: (...args: unknown[]) => resolveBrandByHostMock(...args),
}))

const resolveBrandsForTeamsMock = vi.fn()
vi.mock('@/lib/branding/team-brands', () => ({
  resolveBrandsForTeams: (...args: unknown[]) => resolveBrandsForTeamsMock(...args),
}))

import { GET } from '../route'

const noParams = { params: Promise.resolve({}) }

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  resolveBrandByHostMock.mockResolvedValue(null)
  resolveBrandsForTeamsMock.mockResolvedValue(new Map())
})

function membership(role: string) {
  return { team_id: 'byra-1', role, teams: { kind: 'byra' } }
}

describe('GET /api/clients/landing', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/clients/landing'), noParams)
    expect(res.status).toBe(401)
  })

  it('non-byrå user lands on /', async () => {
    authed()
    enqueue({ data: [] })

    const res = await GET(createMockRequest('/api/clients/landing'), noParams)
    const { status, body } = await parseJsonResponse<{ data: { destination: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.destination).toBe('/')
  })

  it('byrå owner on the canonical host lands in the cockpit', async () => {
    authed()
    enqueue({ data: [membership('owner')] })

    const res = await GET(createMockRequest('/api/clients/landing'), noParams)
    const { body } = await parseJsonResponse<{ data: { destination: string } }>(res)

    expect(body.data.destination).toBe('/clients')
    // The mock returns fixtures regardless of the select string, so pin the
    // role column into the query: dropping it would send every owner to '/'
    // while these tests stayed green.
    expect(findCall('team_members', 'select')?.[0]).toContain('role')
  })

  it('byrå admin on the canonical host lands in the cockpit', async () => {
    authed()
    enqueue({ data: [membership('admin')] })

    const res = await GET(createMockRequest('/api/clients/landing'), noParams)
    const { body } = await parseJsonResponse<{ data: { destination: string } }>(res)

    expect(body.data.destination).toBe('/clients')
  })

  it('plain byrå member lands on / like a regular user (role gate)', async () => {
    authed()
    enqueue({ data: [membership('member')] })

    const res = await GET(createMockRequest('/api/clients/landing'), noParams)
    const { body } = await parseJsonResponse<{ data: { destination: string } }>(res)

    expect(body.data.destination).toBe('/')
    // No qualifying teams: the brand lookup must not run.
    expect(resolveBrandsForTeamsMock).not.toHaveBeenCalled()
  })

  it('mixed roles: an admin membership still wins the cockpit landing', async () => {
    authed()
    enqueue({ data: [membership('member'), { team_id: 'byra-2', role: 'admin', teams: { kind: 'byra' } }] })

    const res = await GET(createMockRequest('/api/clients/landing'), noParams)
    const { body } = await parseJsonResponse<{ data: { destination: string } }>(res)

    expect(body.data.destination).toBe('/clients')
    // Only the qualifying team reaches the brand lookup.
    expect(resolveBrandsForTeamsMock).toHaveBeenCalledWith(['byra-2'])
  })
})
