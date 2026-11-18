import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset, findCalls, calls } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  hashInviteToken: (t: string) => `hash-${t}`,
}))

import {
  acceptPendingInviteByToken,
  acceptPendingTeamInviteByToken,
  hasPendingInviteForEmail,
  redeemCompanyInvitation,
} from '../pending-invites'

const user = { id: 'user-1', email: 'invitee@test.se' }

const futureIso = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const pastIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

const pendingInvite = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  company_id: 'co-1',
  email: 'invitee@test.se',
  role: 'admin',
  status: 'pending',
  expires_at: futureIso(),
  ...overrides,
})

const teamInvite = (overrides: Record<string, unknown> = {}) => ({
  id: 'ti-1',
  team_id: 'team-1',
  email: 'invitee@test.se',
  role: 'admin',
  status: 'pending',
  expires_at: futureIso(),
  teams: { name: 'Byrån', kind: 'byra' },
  ...overrides,
})

/** The claim won: the invitation moved from pending to accepted and came back. */
const claimed = (id: string) => ({ data: [{ id }] })
/** The claim lost: nothing was pending any more, so no row came back. */
const claimLost = { data: [] }

/** Every write, in order, as `table.method`. */
const writes = () =>
  calls
    .filter((c) => ['insert', 'update', 'upsert'].includes(c.method))
    .map((c) => `${c.table}.${c.method}`)

let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorLog.mockRestore()
})

// The claim that makes an invitation single-use (CASA 1.3.2). The behaviour
// across two requests is in app/api/team/accept/__tests__/single-use.test.ts;
// these pin the statements themselves.
describe('redeemCompanyInvitation', () => {
  const invite = { id: 'inv-1', company_id: 'co-1', role: 'admin' }

  it('claims the invitation, then creates the membership', async () => {
    enqueue(claimed('inv-1'))
    enqueue({}) // company_members insert

    await expect(redeemCompanyInvitation(serviceSupabase as never, 'user-1', invite)).resolves.toBe('accepted')

    expect(writes()).toEqual(['company_invitations.update', 'company_members.insert'])
    expect(findCalls('company_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
    expect(findCalls('company_invitations', 'eq')).toEqual([
      ['id', 'inv-1'],
      ['status', 'pending'],
    ])
    expect(findCalls('company_invitations', 'gt')[0]![0]).toBe('expires_at')
    expect(findCalls('company_members', 'insert')[0]![0]).toEqual({
      company_id: 'co-1',
      user_id: 'user-1',
      role: 'admin',
      source: 'direct',
    })
  })

  it('creates nothing when the claim comes back empty', async () => {
    enqueue(claimLost)

    await expect(redeemCompanyInvitation(serviceSupabase as never, 'user-1', invite)).resolves.toBe('gone')

    expect(writes()).toEqual(['company_invitations.update'])
  })

  it('creates nothing when the claim itself fails, and gives nothing back', async () => {
    enqueue({ error: { message: 'boom' } })

    await expect(redeemCompanyInvitation(serviceSupabase as never, 'user-1', invite)).resolves.toBe('error')

    // Not claimed by this request, so there is no claim of its own to undo.
    expect(writes()).toEqual(['company_invitations.update'])
  })

  it('gives the claim back when the membership insert fails', async () => {
    enqueue(claimed('inv-1'))
    enqueue({ error: { code: '42501', message: 'denied' } }) // company_members insert
    enqueue({}) // release

    await expect(redeemCompanyInvitation(serviceSupabase as never, 'user-1', invite)).resolves.toBe('error')

    expect(writes()).toEqual([
      'company_invitations.update',
      'company_members.insert',
      'company_invitations.update',
    ])
    expect(findCalls('company_invitations', 'update')).toEqual([
      [{ status: 'accepted' }],
      [{ status: 'pending' }],
    ])
    // The release only takes back a row this request left accepted.
    expect(findCalls('company_invitations', 'eq').slice(2)).toEqual([
      ['id', 'inv-1'],
      ['status', 'accepted'],
    ])
  })

  it('keeps the claim when the membership already exists (23505)', async () => {
    enqueue(claimed('inv-1'))
    enqueue({ error: { code: '23505', message: 'duplicate' } })

    await expect(redeemCompanyInvitation(serviceSupabase as never, 'user-1', invite)).resolves.toBe(
      'already_member',
    )

    expect(findCalls('company_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
  })

  it('reports a release that fails too, without throwing', async () => {
    enqueue(claimed('inv-1'))
    enqueue({ error: { code: '42501', message: 'denied' } })
    enqueue({ error: { message: 'still down' } }) // release

    await expect(redeemCompanyInvitation(serviceSupabase as never, 'user-1', invite)).resolves.toBe('error')

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('could not give the invitation claim back'),
      expect.objectContaining({ table: 'company_invitations', invitationId: 'inv-1' }),
    )
  })
})

describe('acceptPendingInviteByToken', () => {
  it('accepts a valid pending invite', async () => {
    enqueue({ data: pendingInvite() }) // invitation lookup
    enqueue(claimed('inv-1')) // invitation claim
    enqueue({}) // company_members insert
    enqueue({}) // user_preferences upsert
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
    expect(writes()).toEqual([
      'company_invitations.update',
      'company_members.insert',
      'user_preferences.upsert',
    ])
  })

  it('treats an existing membership (23505) as fulfilled', async () => {
    enqueue({ data: pendingInvite() })
    enqueue(claimed('inv-1'))
    enqueue({ error: { code: '23505', message: 'duplicate' } })
    enqueue({})
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
    // Fulfilled and spent: the claim is not given back.
    expect(findCalls('company_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
  })

  it('returns false and creates nothing when another request won the claim', async () => {
    enqueue({ data: pendingInvite() })
    enqueue(claimLost)
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(false)
    expect(writes()).toEqual(['company_invitations.update'])
  })

  it('rejects when the invitation is not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(false)
  })

  it('rejects a non-pending invitation', async () => {
    enqueue({ data: pendingInvite({ status: 'accepted' }) })
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(false)
  })

  it('rejects an expired invitation', async () => {
    enqueue({ data: pendingInvite({ expires_at: pastIso() }) })
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(false)
  })

  it('rejects when the email does not match', async () => {
    enqueue({ data: pendingInvite({ email: 'other@test.se' }) })
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(false)
  })

  it('matches emails case-insensitively', async () => {
    enqueue({ data: pendingInvite({ email: 'Invitee@Test.se' }) })
    enqueue(claimed('inv-1'))
    enqueue({})
    enqueue({})
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
  })

  it('rejects when the user has no email', async () => {
    await expect(acceptPendingInviteByToken({ id: 'user-1' }, 'tok')).resolves.toBe(false)
  })

  it('returns false on a non-duplicate membership insert error, with the invitation pending again', async () => {
    enqueue({ data: pendingInvite() })
    enqueue(claimed('inv-1'))
    enqueue({ error: { code: '42501', message: 'denied' } })
    enqueue({}) // release
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(false)
    expect(findCalls('company_invitations', 'update')).toEqual([
      [{ status: 'accepted' }],
      [{ status: 'pending' }],
    ])
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(0)
  })

  it('falls back to the team invite when the token is not a company invite', async () => {
    enqueue({ data: null, error: { message: 'not found' } }) // company lookup miss
    enqueue({ data: teamInvite() }) // team invitation lookup
    enqueue(claimed('ti-1')) // team invitation claim
    enqueue({}) // team_members insert
    enqueue({ data: { active_company_id: 'existing-co' } }) // prefs already set: no company lookup
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
  })
})

describe('acceptPendingTeamInviteByToken', () => {
  it('accepts a valid byrå-team invite and points a company-less user at the first company', async () => {
    enqueue({ data: teamInvite() }) // team invitation lookup
    enqueue(claimed('ti-1')) // team invitation claim
    enqueue({}) // team_members insert
    enqueue({ data: { active_company_id: null } }) // prefs: none set
    enqueue({ data: { id: 'co-1' } }) // first company lookup
    enqueue({}) // prefs upsert

    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'accepted',
      teamId: 'team-1',
      teamName: 'Byrån',
    })

    // Claimed before the membership exists, and only while pending and unexpired.
    expect(writes()).toEqual([
      'team_invitations.update',
      'team_members.insert',
      'user_preferences.upsert',
    ])
    expect(findCalls('team_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
    expect(findCalls('team_invitations', 'eq')).toEqual([
      ['token_hash', 'hash-tok'],
      ['id', 'ti-1'],
      ['status', 'pending'],
    ])
    expect(findCalls('team_invitations', 'gt')[0]![0]).toBe('expires_at')
  })

  it('reports invalid and creates nothing when another request won the claim', async () => {
    enqueue({ data: teamInvite() })
    enqueue(claimLost)

    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({ status: 'invalid' })
    expect(writes()).toEqual(['team_invitations.update'])
  })

  it('accepts a byrå with no companies without setting an active company', async () => {
    enqueue({ data: teamInvite() })
    enqueue(claimed('ti-1'))
    enqueue({}) // team_members insert
    enqueue({ data: { active_company_id: null } }) // prefs: none set
    enqueue({ data: null }) // no company for the team

    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'accepted',
      teamId: 'team-1',
      teamName: 'Byrån',
    })
  })

  it('drops chosen companies that left the team and grants the rest', async () => {
    enqueue({ data: teamInvite({ role: 'member', company_ids: ['co-1', 'co-gone'] }) })
    enqueue(claimed('ti-1'))
    enqueue({ data: { id: 'tm-1' } }) // team_members insert
    enqueue({ data: [{ id: 'co-1' }] }) // only co-1 is still a client of the team
    enqueue({}) // set_team_member_companies
    enqueue({ data: { active_company_id: 'existing' } })

    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(serviceSupabase.rpc).toHaveBeenCalledWith('set_team_member_companies', {
      p_team_member_id: 'tm-1',
      p_company_ids: ['co-1'],
    })
  })

  it('fails closed when the chosen companies cannot be granted: no company, no fallback to all', async () => {
    enqueue({ data: teamInvite({ role: 'member', company_ids: ['co-1'] }) })
    enqueue(claimed('ti-1'))
    enqueue({ data: { id: 'tm-1' } }) // team_members insert
    enqueue({ data: [{ id: 'co-1' }] })
    enqueue({ error: { message: 'boom' } }) // set_team_member_companies fails
    enqueue({ data: { active_company_id: null } }) // prefs: none set

    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(findCalls('team_members', 'insert')[0]?.[0]).toMatchObject({ all_companies: false })
    // No company is reachable, so none becomes the active one.
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(0)
  })

  it('ignores chosen companies on an admin invite: admins have every company', async () => {
    enqueue({ data: teamInvite({ role: 'admin', company_ids: ['co-1'] }) })
    enqueue(claimed('ti-1'))
    enqueue({}) // team_members insert
    enqueue({ data: { active_company_id: 'existing' } })

    await acceptPendingTeamInviteByToken(user, 'tok')
    expect(findCalls('team_members', 'insert')[0]?.[0]).toMatchObject({
      role: 'admin',
      all_companies: true,
    })
    expect(serviceSupabase.rpc).not.toHaveBeenCalled()
  })

  it('caps the role: a member invite never becomes owner', async () => {
    enqueue({ data: teamInvite({ role: 'owner' }) })
    enqueue(claimed('ti-1'))
    enqueue({}) // insert
    enqueue({ data: { active_company_id: 'existing' } })
    await acceptPendingTeamInviteByToken(user, 'tok')
    // The insert wrote 'member' (owner is never granted via invite).
    expect(findCalls('team_members', 'insert')[0]?.[0]).toMatchObject({ role: 'member' })
  })

  it('reports already_member on a duplicate membership (23505), with the invitation spent', async () => {
    enqueue({ data: teamInvite() })
    enqueue(claimed('ti-1'))
    enqueue({ error: { code: '23505', message: 'duplicate' } })
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'already_member',
    })
    expect(findCalls('team_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
  })

  it('reports expired and marks the invite expired', async () => {
    enqueue({ data: teamInvite({ expires_at: pastIso() }) })
    enqueue({}) // status = expired update
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'expired',
    })
  })

  it('reports wrong_email when the account is not the invited one', async () => {
    enqueue({ data: teamInvite({ email: 'other@test.se' }) })
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'wrong_email',
    })
  })

  it('reports invalid for a non-byrå team, a missing row, or a non-pending invite', async () => {
    enqueue({ data: teamInvite({ teams: { name: 'X', kind: 'personal' } }) })
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({ status: 'invalid' })

    enqueue({ data: null })
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({ status: 'invalid' })

    enqueue({ data: teamInvite({ status: 'accepted' }) })
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({ status: 'invalid' })
  })

  it('reports error on a non-duplicate membership insert failure, with the invitation pending again', async () => {
    enqueue({ data: teamInvite() })
    enqueue(claimed('ti-1'))
    enqueue({ error: { code: '42501', message: 'denied' } })
    enqueue({}) // release
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({ status: 'error' })
    expect(findCalls('team_invitations', 'update')).toEqual([
      [{ status: 'accepted' }],
      [{ status: 'pending' }],
    ])
  })

  it('reports invalid when the user has no email', async () => {
    await expect(acceptPendingTeamInviteByToken({ id: 'u' }, 'tok')).resolves.toEqual({
      status: 'invalid',
    })
  })
})

describe('hasPendingInviteForEmail', () => {
  it('returns true when a pending invite row exists', async () => {
    enqueue({ data: [{ id: 'inv-1' }] })
    await expect(hasPendingInviteForEmail('Invitee@Test.se')).resolves.toBe(true)
  })

  it('returns false when there are no rows', async () => {
    enqueue({ data: [] })
    await expect(hasPendingInviteForEmail('invitee@test.se')).resolves.toBe(false)
  })

  it('returns true when only a byrå-team invite exists (company table empty)', async () => {
    enqueue({ data: [] }) // company invites: none
    enqueue({ data: [{ id: 'ti-1' }] }) // team invites: one pending
    await expect(hasPendingInviteForEmail('invitee@test.se')).resolves.toBe(true)
  })

  it('returns false when neither table has a pending invite', async () => {
    enqueue({ data: [] }) // company
    enqueue({ data: [] }) // team
    await expect(hasPendingInviteForEmail('invitee@test.se')).resolves.toBe(false)
  })

  it('returns false when the query errors', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(hasPendingInviteForEmail('invitee@test.se')).resolves.toBe(false)
  })
})
