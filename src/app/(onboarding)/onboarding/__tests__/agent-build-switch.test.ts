import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { billingHref } from '@/lib/entitlements/upgrade-reason'

// /onboarding/agent under ASSISTANT_CHAT_ENABLED (lib/env/assistant-chat-switch.ts).
// The page builds the built-in assistant and ends in the interview on
// /chat/intake. Switched off there is neither,
// so the page leads to /chat, which shows what took its place, before the paywall and
// before anything is fetched or built. Unset or on, it runs as before.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))

const user = vi.fn()
const from = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user() } }) }, from }),
}))
const getActiveCompanyId = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyId(...args),
}))
const hasCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => hasCapability(...args),
}))
const ensureTicSnapshot = vi.fn()
vi.mock('@/lib/agent/composer/tic-fetch', () => ({
  ensureTicSnapshot: (...args: unknown[]) => ensureTicSnapshot(...args),
}))
vi.mock('@/lib/agent/composer/employee-facts', () => ({
  employeeFieldValue: () => null,
  loadActiveEmployeeCount: async () => null,
}))
vi.mock('@/components/onboarding/agent/AgentOnboarding', () => ({ default: () => null }))

const { default: AgentOnboardingPage } = await import('../agent/page')

beforeEach(() => {
  vi.clearAllMocks()
  user.mockReturnValue({ id: 'user-1' })
  getActiveCompanyId.mockResolvedValue('company-1')
  hasCapability.mockResolvedValue(false)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe.each(['false', '0', 'off', 'no', 'OFF'])('/onboarding/agent with ASSISTANT_CHAT_ENABLED=%s', (value) => {
  beforeEach(() => {
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', value)
  })

  it('leads to /chat, with nothing fetched or built', async () => {
    await expect(AgentOnboardingPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    expect(from).not.toHaveBeenCalled()
    expect(ensureTicSnapshot).not.toHaveBeenCalled()
  })

  it('does not send a company without the ai capability to billing for an assistant that is not there', async () => {
    await expect(AgentOnboardingPage()).rejects.toThrow('NEXT_REDIRECT:/chat')
    expect(hasCapability).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalledWith(billingHref('assistant'))
  })

  it('still sends a signed-out visitor to the login and a user without a company to onboarding first', async () => {
    user.mockReturnValue(null)
    await expect(AgentOnboardingPage()).rejects.toThrow('NEXT_REDIRECT:/login')
    user.mockReturnValue({ id: 'user-1' })
    getActiveCompanyId.mockResolvedValue(null)
    await expect(AgentOnboardingPage()).rejects.toThrow('NEXT_REDIRECT:/onboarding')
  })
})

describe.each([
  ['unset', undefined],
  ['empty', ''],
  ['true', 'true'],
  ['any other value', 'later'],
])('/onboarding/agent with ASSISTANT_CHAT_ENABLED %s: as before', (_name, value) => {
  beforeEach(() => {
    if (value !== undefined) vi.stubEnv('ASSISTANT_CHAT_ENABLED', value)
  })

  it('goes on to the paywall: a company without the ai capability is sent to billing', async () => {
    await expect(AgentOnboardingPage()).rejects.toThrow(`NEXT_REDIRECT:${billingHref('assistant')}`)
    expect(hasCapability).toHaveBeenCalledTimes(1)
    expect(redirect).not.toHaveBeenCalledWith('/chat')
  })
})
