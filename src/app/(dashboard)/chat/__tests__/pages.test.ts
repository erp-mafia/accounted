import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// ASSISTANT_CHAT_ENABLED (lib/env/assistant-chat-switch.ts) on the /chat
// pages. Switched off, every one of them sends its visitor to Koppla en agent
// (/settings/api): the start page, a new conversation, a stored conversation
// and the onboarding interview, which starts on /chat/intake and continues as
// an ordinary conversation on /chat/[id] (the interview goes with the rest).
// Unset or on, nothing here redirects.

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
vi.mock('@/components/agent/ChatNewStarter', () => ({ default: () => null }))
vi.mock('@/components/agent/ChatIntakeStarter', () => ({ default: () => null }))
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

  it('opens the start page, a new conversation, a conversation and the intake', async () => {
    expect(ChatIndexPage()).toBeTruthy()
    expect(await newPage()).toBeTruthy()
    enqueueConversation('general.help')
    expect(await conversationPage()).toBeTruthy()
    expect(await ChatIntakePage()).toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('leaves the build gate to the chat layout: no page reads the agent profile', async () => {
    enqueueConversation('general.help')
    await conversationPage()
    await ChatIntakePage()
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

  it('sends the start page to Koppla en agent', () => {
    expect(() => ChatIndexPage()).toThrow('NEXT_REDIRECT:/settings/api')
  })

  it('sends a new conversation to Koppla en agent, whatever intent the link names', async () => {
    await expect(newPage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    await expect(
      ChatNewPage({ searchParams: Promise.resolve({ intent: 'onboarding.intake', prompt: 'Hej' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/settings/api')
  })

  it('still sends a signed-out visitor to the login first', async () => {
    user.mockReturnValue(null)
    await expect(newPage()).rejects.toThrow('NEXT_REDIRECT:/login')
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/login')
    await expect(ChatIntakePage()).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it.each(['general.help', 'verifikation.draft', 'transaction.categorization', 'onboarding.intake'])(
    'sends a %s conversation to Koppla en agent',
    async (intentId) => {
      enqueueConversation(intentId)
      await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    },
  )

  it('sends a conversation that does not exist to Koppla en agent, built agent or not', async () => {
    enqueueConversation(null)
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    getResolvedDashboardAgentProfile.mockResolvedValue(null)
    enqueueConversation('general.help')
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    expect(notFound).not.toHaveBeenCalled()
  })

  it('reads nothing for a conversation before it leaves', async () => {
    await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('does not start the onboarding interview: /chat/intake leads to Koppla en agent', async () => {
    await expect(ChatIntakePage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
  })

  it('never sends anyone into the build, built agent or not', async () => {
    for (const agent of [null, { ...BUILT, verified_at: null }, BUILT]) {
      getResolvedDashboardAgentProfile.mockResolvedValue(agent)
      await expect(ChatIntakePage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
      enqueueConversation('onboarding.intake')
      await expect(conversationPage()).rejects.toThrow('NEXT_REDIRECT:/settings/api')
    }
    expect(redirect).not.toHaveBeenCalledWith('/onboarding/agent')
  })
})
