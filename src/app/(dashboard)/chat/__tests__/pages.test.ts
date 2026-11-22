import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// ASSISTANT_CHAT_ENABLED (lib/env/assistant-chat-switch.ts) on the /chat
// pages. Switched off, /chat shows what took the chat's place and every other
// page leads there: a new conversation and a stored conversation, whatever
// its intent. A company on ASSISTANT_CHAT_COMPANY_IDS keeps every page
// through ASSISTANT_CHAT_UNTIL. Unset or on, nothing here redirects.
//
// /chat/intake started the onboarding interview, which is removed: the
// address leads to the start page, and a conversation the interview left
// behind (intent onboarding.intake) still opens like any other.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}))
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }))

vi.mock('@/components/agent/ChatEmptyState', () => ({ default: () => null }))
vi.mock('@/components/agent/ChatReplaced', () => ({ ChatReplaced: () => null }))
vi.mock('@/components/agent/ChatNewStarter', () => ({ default: () => null }))
vi.mock('@/components/agent/ChatConversationView', () => ({ default: () => null }))
vi.mock('@/lib/agent/intents/registry', () => ({ getIntent: (id: string) => ({ id }) }))
vi.mock('@/lib/ai', () => ({ getAiStatus: () => ({ configured: true, assistantAvailable: true }) }))

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const user = vi.fn()
const getResolvedDashboardAgentProfile = vi.fn()
vi.mock('../../request-context', () => ({
  getDashboardAuthContext: async () => ({ user: user(), supabase }),
  getDashboardCompanyId: async () => 'company-1',
  getResolvedDashboardAgentProfile: () => getResolvedDashboardAgentProfile(),
}))

const { default: ChatIndexPage } = await import('../page')
const { ChatReplaced } = await import('@/components/agent/ChatReplaced')
const { default: ChatEmptyState } = await import('@/components/agent/ChatEmptyState')
const { default: ChatNewPage } = await import('../new/page')
const { default: ChatIntakePage } = await import('../intake/page')
const { default: ChatConversationPage } = await import('../[id]/page')

const BUILT = { display_name: 'Anna', avatar_id: null, verified_at: '2026-10-10T14:04:42Z' }
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'

const newPage = () => ChatNewPage({ searchParams: Promise.resolve({}) })
const conversationPage = () => ChatConversationPage({ params: Promise.resolve({ id: CONVERSATION_ID }) })

/** The three reads of /chat/[id], in the order the page makes them. */
function enqueueConversation(intentId: string | null) {
  enqueue({ data: intentId ? { id: CONVERSATION_ID, intent_id: intentId, context_ref: null, title: null } : null })
  enqueue({ data: [] }) // agent_messages
  enqueue({ data: [] }) // pending_operations
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  user.mockReturnValue({ id: 'user-1' })
  getResolvedDashboardAgentProfile.mockResolvedValue(BUILT)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe.each([
  ['unset', undefined],
  ['empty', ''],
  ['true', 'true'],
  ['any other value', 'later'],
])('the /chat pages with ASSISTANT_CHAT_ENABLED %s: as before', (_name, value) => {
  beforeEach(() => {
    if (value !== undefined) vi.stubEnv('ASSISTANT_CHAT_ENABLED', value)
  })

  it('opens the start page, a new conversation and a conversation', async () => {
    expect((await ChatIndexPage()).type).toBe(ChatEmptyState)
    expect(await newPage()).toBeTruthy()
    enqueueConversation('general.help')
    expect(await conversationPage()).toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('still opens a conversation the removed interview left behind', async () => {
    enqueueConversation('onboarding.intake')
    expect(await conversationPage()).toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
    expect(notFound).not.toHaveBeenCalled()
  })

  it('sends the old interview address to the start page', () => {
    expect(() => ChatIntakePage()).toThrow('NEXT_REDIRECT:/chat')
    expect(redirect).toHaveBeenCalledTimes(1)
  })

  it('leaves the built-assistant gate to the chat layout: no page reads the agent profile', async () => {
    enqueueConversation('general.help')
    await conversationPage()
    expect(getResolvedDashboardAgentProfile).not.toHaveBeenCalled()
  })

  it('answers a conversation that does not exist with not found', async () => {
    enqueueConversation(null)
    await expect(conversationPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })
})

describe.each(['false', '0', 'off', 'no', 'OFF'])('the /chat pages with ASSISTANT_CHAT_ENABLED=%s', (value) => {
  beforeEach(() => {
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', value)
  })

  it('shows on the start page what replaced the chat, with no day while none is set', async () => {
    const page = await ChatIndexPage()
    expect(page.type).toBe(ChatReplaced)
    expect(page.props).toEqual({ until: null })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('names the last day on that page when one is set', async () => {
    vi.stubEnv('ASSISTANT_CHAT_UNTIL', '2099-01-31')
    expect((await ChatIndexPage()).props).toEqual({ until: '2099-01-31' })
  })

  it('sends a new conversation to the start page, whatever intent the link names', async () => {
    await expect(newPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    await expect(
      ChatNewPage({ searchParams: Promise.resolve({ intent: 'onboarding.intake', prompt: 'Hej' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/chat')
  })

  it('still sends a signed-out visitor to the login first', async () => {
    user.mockReturnValue(null)
    await expect(newPage()).rejects.toThrow('NEXT_REDIRECT:/login')
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it.each(['general.help', 'verifikation.draft', 'transaction.categorization', 'onboarding.intake'])(
    'sends a %s conversation to the start page',
    async (intentId) => {
      enqueueConversation(intentId)
      await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    },
  )

  it('sends a conversation that does not exist to the start page, built agent or not', async () => {
    enqueueConversation(null)
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    getResolvedDashboardAgentProfile.mockResolvedValue(null)
    enqueueConversation('general.help')
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    expect(notFound).not.toHaveBeenCalled()
  })

  it('reads nothing for a conversation before it leaves', async () => {
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('sends the old interview address to the start page', () => {
    expect(() => ChatIntakePage()).toThrow('NEXT_REDIRECT:/chat')
  })

  it('never sends anyone into the build, built agent or not', async () => {
    for (const agent of [null, { ...BUILT, verified_at: null }, BUILT]) {
      getResolvedDashboardAgentProfile.mockResolvedValue(agent)
      expect(() => ChatIntakePage()).toThrow('NEXT_REDIRECT:/chat')
      enqueueConversation('onboarding.intake')
      await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    }
    expect(redirect).not.toHaveBeenCalledWith('/onboarding/agent')
  })
})

describe('the /chat pages for a company that keeps the chat while it is switched off', () => {
  beforeEach(() => {
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', 'false')
    vi.stubEnv('ASSISTANT_CHAT_COMPANY_IDS', 'another-company, COMPANY-1')
  })

  it('opens every page as before, through the last day', async () => {
    vi.stubEnv('ASSISTANT_CHAT_UNTIL', '2099-01-31')
    expect((await ChatIndexPage()).type).toBe(ChatEmptyState)
    expect(await newPage()).toBeTruthy()
    enqueueConversation('verifikation.draft')
    expect(await conversationPage()).toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('loses them the day after the last day', async () => {
    vi.stubEnv('ASSISTANT_CHAT_UNTIL', '2000-01-31')
    expect((await ChatIndexPage()).type).toBe(ChatReplaced)
    await expect(newPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    expect(() => ChatIntakePage()).toThrow('NEXT_REDIRECT:/chat')
  })

  it('gives a company that is not on the list nothing', async () => {
    vi.stubEnv('ASSISTANT_CHAT_COMPANY_IDS', 'another-company')
    expect((await ChatIndexPage()).type).toBe(ChatReplaced)
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
  })
})
