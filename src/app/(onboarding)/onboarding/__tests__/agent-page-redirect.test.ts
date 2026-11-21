import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// /onboarding/agent was the build of the built-in assistant. The build is
// removed; the address stays and leads to /chat, whatever
// ASSISTANT_CHAT_ENABLED says and with nothing read on the way.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))

const { default: AgentOnboardingPage } = await import('../agent/page')

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('/onboarding/agent', () => {
  it.each([undefined, 'true', 'false'])('leads to /chat with ASSISTANT_CHAT_ENABLED %j', (value) => {
    if (value !== undefined) vi.stubEnv('ASSISTANT_CHAT_ENABLED', value)
    expect(() => AgentOnboardingPage()).toThrow('NEXT_REDIRECT:/chat')
    expect(redirect).toHaveBeenCalledTimes(1)
  })
})
