import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('acceptPendingInviteByToken', () => {
  it('accepts a valid pending invite', async () => {
    enqueue({ data: pendingInvite() }) // invitation lookup
    enqueue({}) // company_members insert
    enqueue({}) // user_preferences upsert
    enqueue({}) // invitation status update
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
  })

  it('treats an existing membership (23505) as fulfilled', async () => {
    enqueue({ data: pendingInvite() })
    enqueue({ error: { code: '23505', message: 'duplicate' } })
    enqueue({})
    enqueue({})
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
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
    enqueue({})
    enqueue({})
    enqueue({})
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
  })

  it('rejects when the user has no email', async () => {
    await expect(acceptPendingInviteByToken({ id: 'user-1' }, 'tok')).resolves.toBe(false)
  })

  it('returns false on a non-duplicate membership insert error', async () => {
    enqueue({ data: pendingInvite() })
    enqueue({ error: { code: '42501', message: 'denied' } })
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(false)
  })

  it('falls back to the team invite when the token is not a company invite', async () => {
    enqueue({ data: null, error: { message: 'not found' } }) // company lookup miss
    enqueue({ data: teamInvite() }) // team invitation lookup
    enqueue({}) // team_members insert
    enqueue({ data: { active_company_id: 'existing-co' } }) // prefs already set: no company lookup
    enqueue({}) // team_invitations status update
    await expect(acceptPendingInviteByToken(user, 'tok')).resolves.toBe(true)
  })
})

describe('acceptPendingTeamInviteByToken', () => {
  it('accepts a valid byrå-team invite and points a company-less user at the first company', async () => {
    enqueue({ data: teamInvite() }) // team invitation lookup
    enqueue({}) // team_members insert
    enqueue({ data: { active_company_id: null } }) // prefs: none set
    enqueue({ data: { id: 'co-1' } }) // first company lookup
    enqueue({}) // prefs upsert
    enqueue({}) // team_invitations status update

    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'accepted',
      teamId: 'team-1',
      teamName: 'Byrån',
    })
  })

  it('accepts a byrå with no companies without setting an active company', async () => {
    enqueue({ data: teamInvite() })
    enqueue({}) // team_members insert
    enqueue({ data: { active_company_id: null } }) // prefs: none set
    enqueue({ data: null }) // no company for the team
    enqueue({}) // team_invitations status update

    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'accepted',
      teamId: 'team-1',
      teamName: 'Byrån',
    })
  })

  it('caps the role: a member invite never becomes owner', async () => {
    enqueue({ data: teamInvite({ role: 'owner' }) })
    enqueue({}) // insert
    enqueue({ data: { active_company_id: 'existing' } })
    enqueue({}) // status update
    await acceptPendingTeamInviteByToken(user, 'tok')
    // The insert wrote 'member' (owner is never granted via invite).
    expect(findCalls('team_members', 'insert')[0]?.[0]).toMatchObject({ role: 'member' })
  })

  it('reports already_member on a duplicate membership (23505)', async () => {
    enqueue({ data: teamInvite() })
    enqueue({ error: { code: '23505', message: 'duplicate' } })
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({
      status: 'already_member',
    })
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

  it('reports error on a non-duplicate membership insert failure', async () => {
    enqueue({ data: teamInvite() })
    enqueue({ error: { code: '42501', message: 'denied' } })
    await expect(acceptPendingTeamInviteByToken(user, 'tok')).resolves.toEqual({ status: 'error' })
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
