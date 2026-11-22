import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// crm#1135: a new account saw no assistant anywhere. Every entry point waits
// for a built agent (agent_profiles.verified_at), and /chat forwarded an
// unbuilt agent to Hem, so the Assistent nav entry had to hide too. /chat then
// led to the build, which let that entry always show. The build is removed:
// a company without a built assistant is led to Koppla en agent
// (/settings/api), where its own assistant connects.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))
const ChatSidebar = vi.fn(() => null)
vi.mock('@/components/agent/ChatSidebar', () => ({ default: ChatSidebar }))

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

  it('sends a company with no agent to Koppla en agent, not to Hem and not to the removed build', async () => {
    getResolvedDashboardAgentProfile.mockResolvedValue(null)
    await expect(ChatLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    expect(redirect).toHaveBeenCalledWith('/settings/api')
    expect(redirect).not.toHaveBeenCalledWith('/onboarding/agent')
    expect(conversations).not.toHaveBeenCalled()
  })

  it('sends a build that was started but never confirmed to Koppla en agent too', async () => {
    getResolvedDashboardAgentProfile.mockResolvedValue({ display_name: 'Anna', avatar_id: null, verified_at: null })
    await expect(ChatLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    expect(conversations).not.toHaveBeenCalled()
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
    expect(sidebarOf(out)).toBe(ChatSidebar)
  })
})

/** The component in the layout's sidebar slot, or undefined when the slot is empty. */
function sidebarOf(layout: unknown): unknown {
  const [slot] = (layout as { props: { children: unknown[] } }).props.children
  return slot ? (slot as { type: unknown }).type : undefined
}

// ASSISTANT_CHAT_ENABLED (lib/env/assistant-chat-switch.ts). Switched off for
// the company, the layout draws no chat around its page: /chat shows what
// took the chat's place and the other pages lead there (chat-switch.ts,
// pages.test.ts), before the built-assistant gate and before the conversation list.
describe('ChatLayout with the chat switched off', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    conversations.mockResolvedValue({ data: [], error: null })
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', 'false')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not lead a company without an agent anywhere: the page is shown as it is', async () => {
    getResolvedDashboardAgentProfile.mockResolvedValue(null)
    const out = await ChatLayout({ children: 'the page' })
    expect((out as { props: { children: unknown } }).props.children).toBe('the page')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('draws no sidebar for a company with a built agent either, and does not read the conversation list', async () => {
    getResolvedDashboardAgentProfile.mockResolvedValue({
      display_name: 'Anna',
      avatar_id: null,
      verified_at: '2026-10-10T14:04:42Z',
    })
    await ChatLayout({ children: null })
    expect(conversations).not.toHaveBeenCalled()
    expect(ChatSidebar).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('is the chat as before for a company that keeps it', async () => {
    vi.stubEnv('ASSISTANT_CHAT_COMPANY_IDS', 'company-1')
    getResolvedDashboardAgentProfile.mockResolvedValue({
      display_name: 'Anna',
      avatar_id: null,
      verified_at: '2026-10-10T14:04:42Z',
    })
    const out = await ChatLayout({ children: null })
    expect(conversations).toHaveBeenCalledTimes(1)
    expect(sidebarOf(out)).toBe(ChatSidebar)
  })
})
