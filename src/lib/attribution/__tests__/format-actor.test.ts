import { describe, it, expect } from 'vitest'
import {
  agentDisplayName,
  attributionWordsFrom,
  formatActorAttribution,
  mcpClientDisplayName,
  RESERVED_OAUTH_KEY_NAME,
  SV_ATTRIBUTION_WORDS,
} from '../format-actor'
import { credentialActor, OAUTH_MCP_KEY_NAME } from '@/lib/auth/api-keys'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

/** A translator over one message namespace, the way next-intl fills {placeholders}. */
function translator(messages: Record<string, string>) {
  return (key: string, values: Record<string, string> = {}) =>
    messages[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`)
}

describe('agentDisplayName', () => {
  it('drops the provider suffix a connector label carries', () => {
    expect(agentDisplayName('api_key', 'Claude (Anthropic)')).toBe('Claude')
    expect(agentDisplayName('api_key', 'ChatGPT (OpenAI)')).toBe('ChatGPT')
    expect(agentDisplayName('mcp_oauth', 'Grok (xAI)')).toBe('Grok')
    expect(agentDisplayName('mcp_oauth', 'Copilot Studio (Microsoft)')).toBe('Copilot Studio')
    expect(agentDisplayName('api_key', 'Cursor')).toBe('Cursor')
  })

  it('names a registered client by its own name', () => {
    expect(agentDisplayName('api_key', 'Lagerroboten (registered client)')).toBe('Lagerroboten')
  })

  it('reads the reserved OAuth key name as a neutral AI connection', () => {
    expect(agentDisplayName('api_key', RESERVED_OAUTH_KEY_NAME)).toBe('AI-anslutning')
    expect(agentDisplayName('mcp_oauth', null)).toBe('AI-anslutning')
  })

  it("keeps a manual key's and a service account's own name, parentheses included", () => {
    expect(agentDisplayName('api_key', 'Lagerskript')).toBe('Lagerskript')
    expect(agentDisplayName('api_key', 'Lager (test)')).toBe('Lager (test)')
    expect(agentDisplayName('service_account', 'Lager')).toBe('Lager')
  })

  it('names the actors without a label by what they are', () => {
    expect(agentDisplayName('api_key', null)).toBe('En API-nyckel')
    expect(agentDisplayName('service_account', '  ')).toBe('Ett tjänstekonto')
    expect(agentDisplayName('agent_chat', 'Chatt 12')).toBe('Assistenten')
    expect(agentDisplayName('cron', 'avskrivningar')).toBe('Schemalagd körning')
    expect(agentDisplayName('system', null)).toBe('Systemet')
  })

  it('reads a person as their label', () => {
    expect(agentDisplayName('user', 'anna@example.se')).toBe('anna@example.se')
    expect(agentDisplayName('user', null)).toBe('En användare')
  })

  it('keeps a generic word lower-case inside a sentence', () => {
    expect(agentDisplayName('agent_chat', null, SV_ATTRIBUTION_WORDS, { inline: true })).toBe('assistenten')
  })
})

describe('formatActorAttribution', () => {
  const person = 'Jonas Ek'

  it('names a connector and the person it acted for', () => {
    expect(formatActorAttribution({ actorType: 'api_key', actorLabel: 'Claude (Anthropic)', personName: person })).toBe('Claude åt Jonas Ek')
    expect(formatActorAttribution({ actorType: 'mcp_oauth', actorLabel: 'ChatGPT (OpenAI)', personName: person })).toBe('ChatGPT åt Jonas Ek')
  })

  it('names a manual key by its name', () => {
    expect(formatActorAttribution({ actorType: 'api_key', actorLabel: 'Lagerskript', personName: person })).toBe('Lagerskript åt Jonas Ek')
  })

  it('names a service account and its sponsor', () => {
    expect(formatActorAttribution({ actorType: 'service_account', actorLabel: 'Lager', personName: person })).toBe('Tjänstekontot Lager åt Jonas Ek')
    expect(formatActorAttribution({ actorType: 'service_account', actorLabel: null, personName: person })).toBe('Ett tjänstekonto åt Jonas Ek')
  })

  it('names the assistant and the person who chatted', () => {
    expect(formatActorAttribution({ actorType: 'agent_chat', actorLabel: null, personName: person })).toBe('Assistenten åt Jonas Ek')
  })

  it('reads the reserved OAuth key as an AI connection', () => {
    expect(formatActorAttribution({ actorType: 'api_key', actorLabel: OAUTH_MCP_KEY_NAME, personName: person })).toBe('AI-anslutning åt Jonas Ek')
  })

  it('answers the agent alone when the person is unknown', () => {
    expect(formatActorAttribution({ actorType: 'api_key', actorLabel: 'Claude (Anthropic)' })).toBe('Claude')
    expect(formatActorAttribution({ actorType: 'agent_chat', personName: ' ' })).toBe('Assistenten')
    expect(formatActorAttribution({ actorType: 'service_account', actorLabel: 'Lager', personName: null })).toBe('Tjänstekontot Lager')
  })

  it('never says a scheduled run or the system acted for someone', () => {
    expect(formatActorAttribution({ actorType: 'cron', actorLabel: 'avskrivningar', personName: person })).toBe('Schemalagd körning')
    expect(formatActorAttribution({ actorType: 'system', actorLabel: null, personName: person })).toBe('Systemet')
  })

  it('reads a person as the person, an unknown type included', () => {
    expect(formatActorAttribution({ actorType: 'user', actorLabel: 'jonas@ek.se', personName: person })).toBe('Jonas Ek')
    expect(formatActorAttribution({ actorType: 'user', actorLabel: 'jonas@ek.se' })).toBe('jonas@ek.se')
    expect(formatActorAttribution({ actorType: null, actorLabel: null })).toBe('En användare')
  })

  it('keeps a generic word lower-case inside a sentence, and a name as it is', () => {
    const inline = { inline: true }
    expect(formatActorAttribution({ actorType: 'agent_chat', personName: person }, SV_ATTRIBUTION_WORDS, inline)).toBe('assistenten åt Jonas Ek')
    expect(formatActorAttribution({ actorType: 'service_account', actorLabel: 'Lager', personName: person }, SV_ATTRIBUTION_WORDS, inline)).toBe('tjänstekontot Lager åt Jonas Ek')
    expect(formatActorAttribution({ actorType: 'api_key', actorLabel: 'Claude (Anthropic)', personName: person }, SV_ATTRIBUTION_WORDS, inline)).toBe('Claude åt Jonas Ek')
  })
})

describe('the words', () => {
  it('pins the reserved name to the one the OAuth token route mints', () => {
    expect(RESERVED_OAUTH_KEY_NAME).toBe(OAUTH_MCP_KEY_NAME)
  })

  it('strips every provider suffix the records carry', () => {
    for (const client of ['claude', 'chatgpt', 'grok', 'cursor']) {
      const { type, label } = credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, client, serviceAccount: null })
      expect(agentDisplayName(type, label)).not.toMatch(/\(/)
    }
  })

  it('reads the same in Swedish from the messages as the built-in words', () => {
    const words = attributionWordsFrom(translator(sv.attribution))
    const input = { actorType: 'service_account', actorLabel: 'Lager', personName: 'Jonas Ek' }
    expect(formatActorAttribution(input, words)).toBe(formatActorAttribution(input, SV_ATTRIBUTION_WORDS))
    for (const key of Object.keys(SV_ATTRIBUTION_WORDS) as (keyof typeof SV_ATTRIBUTION_WORDS)[]) {
      const ours = SV_ATTRIBUTION_WORDS[key]
      const theirs = words[key]
      if (typeof ours === 'string') expect(theirs).toBe(ours)
    }
  })

  it('reads in English from the English messages', () => {
    const words = attributionWordsFrom(translator(en.attribution))
    expect(formatActorAttribution({ actorType: 'agent_chat', personName: 'Jonas Ek' }, words)).toBe('The assistant for Jonas Ek')
    expect(formatActorAttribution({ actorType: 'api_key', actorLabel: 'Claude (Anthropic)', personName: 'Jonas Ek' }, words)).toBe('Claude for Jonas Ek')
  })
})

describe('mcpClientDisplayName', () => {
  it('names the product behind a stored MCP client label', () => {
    expect(mcpClientDisplayName('claude-connector')).toBe('Claude')
    expect(mcpClientDisplayName('claude-desktop')).toBe('Claude')
    expect(mcpClientDisplayName('claude-code')).toBe('Claude Code')
    expect(mcpClientDisplayName('chatgpt')).toBe('ChatGPT')
    expect(mcpClientDisplayName('Cursor')).toBe('Cursor')
  })

  it('shows no free-text marker: anything unknown is no name', () => {
    expect(mcpClientDisplayName('other')).toBeNull()
    expect(mcpClientDisplayName('jonas-run-17')).toBeNull()
    expect(mcpClientDisplayName(null)).toBeNull()
    expect(mcpClientDisplayName('')).toBeNull()
  })

  it('reads as the agent and the person it saved a fact for', () => {
    const inline = { inline: true }
    const svWords = attributionWordsFrom(translator(sv.attribution))
    const enWords = attributionWordsFrom(translator(en.attribution))
    expect(formatActorAttribution({ actorType: 'mcp_oauth', actorLabel: mcpClientDisplayName('claude-connector'), personName: 'Jonas Ek' }, svWords, inline)).toBe('Claude åt Jonas Ek')
    expect(formatActorAttribution({ actorType: 'mcp_oauth', actorLabel: mcpClientDisplayName('other'), personName: 'Jonas Ek' }, svWords, inline)).toBe('AI-anslutning åt Jonas Ek')
    expect(formatActorAttribution({ actorType: 'mcp_oauth', actorLabel: mcpClientDisplayName('chatgpt'), personName: en.settings.memory_creator_deleted }, enWords, inline)).toBe('ChatGPT for a deleted user')
    expect(formatActorAttribution({ actorType: 'user', personName: null }, svWords, inline)).toBe('en användare')
    expect(translator(sv.settings)('memory_saved_by', { who: 'Claude åt Jonas Ek' })).toBe('Sparad av Claude åt Jonas Ek')
  })
})
