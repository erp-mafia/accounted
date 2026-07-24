import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  hashInviteToken: (t: string) => `hash-${t}`,
}))

import { acceptPendingInviteByToken, hasPendingInviteForEmail } from '../pending-invites'

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

  it('returns false when the query errors', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(hasPendingInviteForEmail('invitee@test.se')).resolves.toBe(false)
  })
})
