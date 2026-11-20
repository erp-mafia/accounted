import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('@/lib/company/pending-invites', () => ({
  acceptPendingInviteByToken: vi.fn(),
  hasPendingInviteForEmail: vi.fn(async () => false),
}))
vi.mock('@/lib/company/context', () => ({ setActiveCompany: vi.fn() }))
vi.mock('@/lib/parties/scb/config', () => ({ isScbConfigured: () => false }))
vi.mock('@/components/onboarding/journey/OnboardingJourney', () => ({ default: () => null }))

import { createClient } from '@/lib/supabase/server'
import OnboardingPage from '../page'

function setup(ensuredTeamId: string | null) {
  const { supabase, mockResult } = createMockSupabase()
  // What a bare first-membership pick would read for a user in both a
  // personal and a byrå team: the byrå row first.
  mockResult({ data: { team_id: 'byra-team' } })
  const rpc = vi.fn(async (fn: string) =>
    fn === 'ensure_user_team' ? { data: ensuredTeamId, error: null } : { data: null, error: null },
  )
  const client = {
    ...supabase,
    rpc,
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1', email: null } } })) },
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return { client, rpc }
}

describe('/onboarding team attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('attaches the new company to the personal team from ensure_user_team, never the first team_members row', async () => {
    const { client, rpc } = setup('personal-team')

    const element = await OnboardingPage({ searchParams: Promise.resolve({}) })

    expect(rpc).toHaveBeenCalledWith('ensure_user_team')
    expect(element.props.teamId).toBe('personal-team')
    expect(client.from).not.toHaveBeenCalledWith('team_members')
  })

  it('sends the user to /login when no team can be ensured', async () => {
    setup(null)

    await expect(OnboardingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/login',
    )
  })
})
