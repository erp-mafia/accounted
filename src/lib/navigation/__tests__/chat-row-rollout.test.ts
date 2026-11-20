/**
 * The Chatt row through navRollouts (ASSISTANT_CHAT_ENABLED and the companies
 * that keep the chat): the menu and the assistant's map of it read the same
 * answer, so both keep the row for as long as some company has the chat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { navRollouts } from '../nav-rollouts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('navRollouts: the Chatt row', () => {
  it('is there for every company while the chat is switched on', () => {
    expect(navRollouts('company-1').assistantChatEnabled).toBe(true)
    expect(navRollouts(null).assistantChatEnabled).toBe(true)
  })

  it('stays for a company without the chat while another still has it: the row leads to what replaced it', () => {
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', 'false')
    vi.stubEnv('ASSISTANT_CHAT_COMPANY_IDS', 'company-1')
    vi.stubEnv('ASSISTANT_CHAT_UNTIL', '2099-12-31')
    expect(navRollouts('company-1').assistantChatEnabled).toBe(true)
    expect(navRollouts('company-2').assistantChatEnabled).toBe(true)
  })

  it('goes for everyone once nobody has the chat', () => {
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', 'false')
    expect(navRollouts('company-1').assistantChatEnabled).toBe(false)
    vi.stubEnv('ASSISTANT_CHAT_COMPANY_IDS', 'company-1')
    vi.stubEnv('ASSISTANT_CHAT_UNTIL', '2000-12-31')
    expect(navRollouts('company-1').assistantChatEnabled).toBe(false)
  })
})
