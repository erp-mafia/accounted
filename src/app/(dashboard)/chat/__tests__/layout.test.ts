import { describe, it, expect, vi, beforeEach } from 'vitest'

// crm#1135: a new account saw no assistant anywhere. Every entry point waits
// for a built agent (agent_profiles.verified_at), and /chat forwarded an
// unbuilt agent to Hem, so the Assistent nav entry had to hide too. /chat now
// leads to the build instead, which is what lets that entry always show.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))
vi.mock('@/components/agent/ChatSidebar', () => ({ default: () => null }))

const getResolvedDashboardAgentProfile = vi.fn()
const conversations = vi.fn()
vi.mock('../../request-context', () => ({
  getDashboardAuthContext: async () => ({
    user: { id: 'user-1' },
    supabase: {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: async () => conversations(),
        }
        return chain
      },
    },
  }),
  getDashboardCompanyId: async () => 'company-1',
  getResolvedDashboardAgentProfile: () => getResolvedDashboardAgentProfile(),
}))

const { default: ChatLayout } = await import('../layout')

describe('ChatLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    conversations.mockResolvedValue({ data: [], error: null })
  })

  it('sends a company with no agent yet to the build flow, not to Hem', async () => {
    getResolvedDashboardAgentProfile.mockResolvedValue(null)
    await expect(ChatLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/onboarding/agent')
    expect(redirect).toHaveBeenCalledWith('/onboarding/agent')
    expect(conversations).not.toHaveBeenCalled()
  })

  it('sends a started but unconfirmed build back to the build flow', async () => {
    getResolvedDashboardAgentProfile.mockResolvedValue({ display_name: 'Anna', avatar_id: null, verified_at: null })
    await expect(ChatLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/onboarding/agent')
  })

  it('renders the chat once the agent is built', async () => {
    getResolvedDashboardAgentProfile.mockResolvedValue({
      display_name: 'Anna',
      avatar_id: null,
      verified_at: '2026-10-10T14:04:42Z',
    })
    const out = await ChatLayout({ children: null })
    expect(out).toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
    expect(conversations).toHaveBeenCalledTimes(1)
  })
})
