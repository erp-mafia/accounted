import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const resolveBrandByHostMock = vi.fn()
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandByHost: (...args: unknown[]) => resolveBrandByHostMock(...args),
}))

const resolveBrandsForTeamsMock = vi.fn()
vi.mock('@/lib/branding/team-brands', () => ({
  resolveBrandsForTeams: (...args: unknown[]) => resolveBrandsForTeamsMock(...args),
}))

import { resolveLandingDestination } from '../landing-server'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const byraMembership = { team_id: 'team-1', role: 'owner', teams: { kind: 'byra' } }

function membership(role: string, teamId = 'team-1') {
  return { team_id: teamId, role, teams: { kind: 'byra' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  resolveBrandByHostMock.mockResolvedValue(null)
  resolveBrandsForTeamsMock.mockResolvedValue(new Map())
})

describe('resolveLandingDestination', () => {
  it('returns / for a user with no byrå membership, without resolving brands', async () => {
    enqueue({ data: [] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.accounted.se')

    expect(dest).toBe('/')
    expect(resolveBrandsForTeamsMock).not.toHaveBeenCalled()
  })

  it('returns /clients for byrå staff on their own brand host', async () => {
    resolveBrandByHostMock.mockResolvedValue({ teamId: 'team-1' })
    resolveBrandsForTeamsMock.mockResolvedValue(
      new Map([['team-1', { domain: 'app.amnas.se', appName: 'Amnas' }]]),
    )
    enqueue({ data: [byraMembership] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.amnas.se')

    expect(dest).toBe('/clients')
    expect(resolveBrandByHostMock).toHaveBeenCalledWith('app.amnas.se')
  })

  it('returns / for byrå staff on a foreign brand host', async () => {
    resolveBrandByHostMock.mockResolvedValue({ teamId: 'team-other' })
    resolveBrandsForTeamsMock.mockResolvedValue(
      new Map([['team-1', { domain: 'app.amnas.se', appName: 'Amnas' }]]),
    )
    enqueue({ data: [byraMembership] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.ziffr.se')

    expect(dest).toBe('/')
  })

  it('returns /clients for a brandless byrå on the canonical host (WL-01)', async () => {
    resolveBrandByHostMock.mockResolvedValue(null)
    resolveBrandsForTeamsMock.mockResolvedValue(new Map())
    enqueue({ data: [byraMembership] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.accounted.se')

    expect(dest).toBe('/clients')
  })

  it('returns / for a branded byrå landing on the canonical host', async () => {
    resolveBrandByHostMock.mockResolvedValue(null)
    resolveBrandsForTeamsMock.mockResolvedValue(
      new Map([['team-1', { domain: 'app.amnas.se', appName: 'Amnas' }]]),
    )
    enqueue({ data: [byraMembership] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.accounted.se')

    expect(dest).toBe('/')
  })

  it('skips the host-brand lookup when host is empty', async () => {
    enqueue({ data: [] })

    const dest = await resolveLandingDestination(client, 'user-1', '')

    expect(dest).toBe('/')
    expect(resolveBrandByHostMock).not.toHaveBeenCalled()
  })

  it('degrades to / when the membership query errors', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.amnas.se')

    expect(dest).toBe('/')
  })

  // Role gate (2026-08-27): only owner/admin get the automatic cockpit
  // landing. Ported from the pre-extraction route tests (PR #1970).
  it('byrå owner on the canonical host lands in the cockpit', async () => {
    enqueue({ data: [membership('owner')] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.accounted.se')

    expect(dest).toBe('/clients')
    // The mock returns fixtures regardless of the select string, so pin the
    // role column into the query: dropping it would send every owner to '/'
    // while these tests stayed green.
    expect(findCall('team_members', 'select')?.[0]).toContain('role')
  })

  it('byrå admin on the canonical host lands in the cockpit', async () => {
    enqueue({ data: [membership('admin')] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.accounted.se')

    expect(dest).toBe('/clients')
  })

  it('plain byrå member lands on / like a regular user (role gate)', async () => {
    enqueue({ data: [membership('member')] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.accounted.se')

    expect(dest).toBe('/')
    // No qualifying teams: the brand lookup must not run.
    expect(resolveBrandsForTeamsMock).not.toHaveBeenCalled()
  })

  it('mixed roles: an admin membership still wins the cockpit landing', async () => {
    enqueue({ data: [membership('member', 'byra-1'), membership('admin', 'byra-2')] })

    const dest = await resolveLandingDestination(client, 'user-1', 'app.accounted.se')

    expect(dest).toBe('/clients')
    // Only the qualifying team reaches the brand lookup.
    expect(resolveBrandsForTeamsMock).toHaveBeenCalledWith(['byra-2'])
  })
})
