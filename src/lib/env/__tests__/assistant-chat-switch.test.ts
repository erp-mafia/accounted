import { describe, expect, it } from 'vitest'
import * as chatSwitch from '../assistant-chat-switch'
import {
  assistantChatEnabled,
  assistantChatEnabledFor,
  assistantChatOffForEveryone,
  assistantChatRowShown,
  assistantChatUntil,
} from '../assistant-chat-switch'

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

describe('the companies that keep the chat while it is switched off (ASSISTANT_CHAT_COMPANY_IDS)', () => {
  const OFF = { ASSISTANT_CHAT_ENABLED: 'false' }
  const KEPT = 'aaaaaaaa-0000-4000-8000-000000000001'
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
  const TODAY = '2026-11-19'

  it('is every company while the chat is switched on, listed or not', () => {
    expect(assistantChatEnabledFor(OTHER, TODAY, {})).toBe(true)
    expect(assistantChatEnabledFor(null, TODAY, { ASSISTANT_CHAT_COMPANY_IDS: KEPT })).toBe(true)
    expect(assistantChatOffForEveryone(TODAY, { ASSISTANT_CHAT_COMPANY_IDS: KEPT })).toBe(false)
  })

  it('is nobody once it is switched off with no list', () => {
    expect(assistantChatEnabledFor(KEPT, TODAY, OFF)).toBe(false)
    expect(assistantChatEnabledFor(KEPT, TODAY, { ...OFF, ASSISTANT_CHAT_COMPANY_IDS: ' , ' })).toBe(false)
    expect(assistantChatOffForEveryone(TODAY, OFF)).toBe(true)
  })

  it('is the listed companies and no other, whatever the spacing and case of the list', () => {
    const env = { ...OFF, ASSISTANT_CHAT_COMPANY_IDS: ` ${KEPT.toUpperCase()} , cccccccc-0000-4000-8000-000000000003` }
    expect(assistantChatEnabledFor(KEPT, TODAY, env)).toBe(true)
    expect(assistantChatEnabledFor(OTHER, TODAY, env)).toBe(false)
    expect(assistantChatEnabledFor(null, TODAY, env)).toBe(false)
    expect(assistantChatEnabledFor(undefined, TODAY, env)).toBe(false)
    expect(assistantChatOffForEveryone(TODAY, env)).toBe(false)
  })

  it('takes no wildcard: a star keeps the chat for nobody', () => {
    expect(assistantChatEnabledFor(KEPT, TODAY, { ...OFF, ASSISTANT_CHAT_COMPANY_IDS: '*' })).toBe(false)
  })

  it('ends for the listed companies the day after ASSISTANT_CHAT_UNTIL', () => {
    const env = { ...OFF, ASSISTANT_CHAT_COMPANY_IDS: KEPT, ASSISTANT_CHAT_UNTIL: '2027-01-31' }
    expect(assistantChatEnabledFor(KEPT, '2027-01-30', env)).toBe(true)
    expect(assistantChatEnabledFor(KEPT, '2027-01-31', env)).toBe(true)
    expect(assistantChatEnabledFor(KEPT, '2027-02-01', env)).toBe(false)
    expect(assistantChatOffForEveryone('2027-01-31', env)).toBe(false)
    expect(assistantChatOffForEveryone('2027-02-01', env)).toBe(true)
  })

  it('never ends the chat for an installation that has it switched on, whatever the day says', () => {
    expect(assistantChatEnabledFor(OTHER, '2030-01-01', { ASSISTANT_CHAT_UNTIL: '2027-01-31' })).toBe(true)
  })
})

describe('the Chatt row in the menu', () => {
  const OFF = { ASSISTANT_CHAT_ENABLED: 'false' }

  it('is there while the chat is switched on', () => {
    expect(assistantChatRowShown('2026-11-19', {})).toBe(true)
  })

  it('stays for every company while some company still has the chat: it leads the others to what replaced it', () => {
    const env = { ...OFF, ASSISTANT_CHAT_COMPANY_IDS: 'company-1', ASSISTANT_CHAT_UNTIL: '2026-12-31' }
    expect(assistantChatRowShown('2026-11-19', env)).toBe(true)
    expect(assistantChatRowShown('2026-12-31', env)).toBe(true)
    // The company the row is drawn for is not asked: one without the chat has it too.
    expect(assistantChatEnabledFor('company-2', '2026-11-19', env)).toBe(false)
  })

  it('goes when the chat is gone for everyone: past the last day, or switched off with nobody keeping it', () => {
    expect(assistantChatRowShown('2027-01-01', { ...OFF, ASSISTANT_CHAT_COMPANY_IDS: 'company-1', ASSISTANT_CHAT_UNTIL: '2026-12-31' })).toBe(false)
    expect(assistantChatRowShown('2026-11-19', OFF)).toBe(false)
  })
})

describe('ASSISTANT_CHAT_UNTIL', () => {
  it('is a calendar day, or nothing', () => {
    expect(assistantChatUntil({ ASSISTANT_CHAT_UNTIL: ' 2027-01-31 ' })).toBe('2027-01-31')
    for (const value of [undefined, '', '31 januari', '2027-1-31', '2027-02-30', '2027-13-01', '2027-01-31T00:00:00Z']) {
      expect(assistantChatUntil({ ASSISTANT_CHAT_UNTIL: value })).toBeNull()
    }
  })

  it('leaves the listed companies their chat when the day is not a date', () => {
    const env = { ASSISTANT_CHAT_ENABLED: 'false', ASSISTANT_CHAT_COMPANY_IDS: 'company-1', ASSISTANT_CHAT_UNTIL: 'soon' }
    expect(assistantChatEnabledFor('company-1', '2999-12-31', env)).toBe(true)
  })
})

describe('no intent is exempt from the switch', () => {
  // Every answer the module gives is for the installation or for a company,
  // never for an intent, so no door can ask it per intent.
  it('has no exemption: nothing the module exports takes an intent', () => {
    expect(Object.keys(chatSwitch).sort()).toEqual([
      'assistantChatEnabled',
      'assistantChatEnabledFor',
      'assistantChatOffForEveryone',
      'assistantChatRowShown',
      'assistantChatUntil',
    ])
  })
})
