import { describe, it, expect } from 'vitest'
import { getIntent } from '../registry'

// The onboarding interview (onboarding.intake) followed the build of the
// built-in assistant, and went with it. Conversations it left behind keep the
// id in agent_conversations.intent_id: they open and read without the
// registry, and POST /api/agent/invoke answers a new turn in one as an unknown
// intent.
describe('intent registry', () => {
  it('resolves the intents the chat still runs', () => {
    expect(getIntent('general.help')?.id).toBe('general.help')
    expect(getIntent('verifikation.draft')?.id).toBe('verifikation.draft')
  })

  it('no longer knows the onboarding interview', () => {
    expect(getIntent('onboarding.intake')).toBeUndefined()
  })
})
