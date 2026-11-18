import { describe, expect, it } from 'vitest'
import * as chatSwitch from '../assistant-chat-switch'
import { assistantChatEnabled } from '../assistant-chat-switch'

describe('assistant chat switch (ASSISTANT_CHAT_ENABLED)', () => {
  it('is on while unset or empty: nobody loses the chat by upgrading', () => {
    expect(assistantChatEnabled({})).toBe(true)
    expect(assistantChatEnabled({ ASSISTANT_CHAT_ENABLED: undefined })).toBe(true)
    expect(assistantChatEnabled({ ASSISTANT_CHAT_ENABLED: '' })).toBe(true)
    expect(assistantChatEnabled({ ASSISTANT_CHAT_ENABLED: '   ' })).toBe(true)
  })

  it.each(['true', '1', 'on', 'yes', 'TRUE', '*', 'enabled', 'nej', 'disabled'])(
    'stays on for %j: only an explicit off value switches it off',
    (value) => {
      expect(assistantChatEnabled({ ASSISTANT_CHAT_ENABLED: value })).toBe(true)
    },
  )

  it.each(['false', '0', 'off', 'no', 'FALSE', 'Off', ' no ', ' 0\n'])('is off for %j', (value) => {
    expect(assistantChatEnabled({ ASSISTANT_CHAT_ENABLED: value })).toBe(false)
  })
})

describe('the onboarding interview under the switch', () => {
  // The interview goes with the rest. The module
  // answers one question for every caller, so no door can ask it per intent.
  it('has no exemption: the switch is the one thing the module exports', () => {
    expect(Object.keys(chatSwitch)).toEqual(['assistantChatEnabled'])
  })
})
