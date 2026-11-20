import { describe, expect, it } from 'vitest'
import { agentPromoOffered } from '../agent-promo-gate'

// The line on Hem that offers to build the built-in assistant. It follows the
// installation's switch (ASSISTANT_CHAT_ENABLED): switched off there is no
// assistant to build, and /onboarding/agent itself leads to Koppla en agent.

const READY = { assistantChatEnabled: true, agentBuilt: false, agentConnected: true, setupClosed: true }

describe('agentPromoOffered', () => {
  it('offers the build to a company with a working connected agent, a closed checklist and no built assistant', () => {
    expect(agentPromoOffered(READY)).toBe(true)
  })

  it('offers nothing once the assistant is built, before an agent has worked, or while the checklist is open', () => {
    expect(agentPromoOffered({ ...READY, agentBuilt: true })).toBe(false)
    expect(agentPromoOffered({ ...READY, agentConnected: false })).toBe(false)
    expect(agentPromoOffered({ ...READY, setupClosed: false })).toBe(false)
  })

  it('offers nothing while the built-in assistant is switched off, whatever else holds', () => {
    expect(agentPromoOffered({ ...READY, assistantChatEnabled: false })).toBe(false)
    expect(
      agentPromoOffered({ assistantChatEnabled: false, agentBuilt: true, agentConnected: false, setupClosed: false }),
    ).toBe(false)
  })
})
