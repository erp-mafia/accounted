import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentChipView,
  aiChatLink,
  aiConnection,
  aiConnectionFromWire,
  aiConnectAction,
  aiPrefilledChatLink,
  connectedAiClients,
  kvittojaktenSkillSlug,
  openAiConnector,
  NO_AI_CONNECTION,
  pickConnectedAiClient,
  unknownAgentOnly,
} from '../ai-clients'

describe('openAiConnector', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('severs opener access before navigating the popup and keeps this tab open', () => {
    const assign = vi.fn()
    const popup = { opener: {} as object | null, location: { replace: vi.fn() } }
    popup.location.replace.mockImplementation(() => expect(popup.opener).toBeNull())
    const open = vi.fn(() => popup)
    vi.stubGlobal('window', { open, location: { assign } })
    openAiConnector('https://claude.ai/customize/connectors')
    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(popup.location.replace).toHaveBeenCalledWith('https://claude.ai/customize/connectors')
    expect(assign).not.toHaveBeenCalled()
  })

  it('continues in this tab when the browser blocks the popup', () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { open: vi.fn(() => null), location: { assign } })
    openAiConnector('https://claude.ai/customize/connectors')
    expect(assign).toHaveBeenCalledWith('https://claude.ai/customize/connectors')
  })
})

describe('connectedAiClients', () => {
  it('reads the three clients off live OAuth keys, in display order, once each', () => {
    expect(
      connectedAiClients([{ client: 'grok' }, { client: 'claude' }, { client: 'claude' }]),
    ).toEqual(['claude', 'grok'])
  })

  it('ignores keys minted before the column, by Cursor, localhost or registered clients', () => {
    expect(
      connectedAiClients([{ client: null }, { client: 'cursor' }, { client: 'local' }, { client: 'cursor_deeplink' }]),
    ).toEqual([])
  })
})

describe('aiConnection', () => {
  it('counts a key minted before the client column as a connected agent with no named client', () => {
    expect(aiConnection([{ client: null }])).toEqual({ connected: true, clients: [] })
  })

  it.each(['cursor', 'local', 'cursor_deeplink', 'some-registered-client'])(
    'counts a %s key as connected without naming it',
    (client) => {
      expect(aiConnection([{ client }])).toEqual({ connected: true, clients: [] })
    },
  )

  it('names only the verified clients when known and unknown keys are mixed', () => {
    expect(aiConnection([{ client: null }, { client: 'grok' }, { client: 'cursor' }, { client: 'claude' }])).toEqual({
      connected: true,
      clients: ['claude', 'grok'],
    })
  })

  it('is not connected without a live OAuth key', () => {
    expect(aiConnection([])).toEqual(NO_AI_CONNECTION)
    expect(NO_AI_CONNECTION).toEqual({ connected: false, clients: [] })
  })

  it('never hands work to an unknown client', () => {
    expect(pickConnectedAiClient(aiConnection([{ client: null }, { client: 'cursor' }]).clients)).toBeNull()
    expect(pickConnectedAiClient(aiConnection([{ client: null }, { client: 'chatgpt' }]).clients)).toBe('chatgpt')
  })
})

describe('aiConnectionFromWire', () => {
  it('keeps a connection that names no client connected', () => {
    expect(aiConnectionFromWire([], true)).toEqual({ connected: true, clients: [] })
  })

  it('reads no flag and no client as not connected', () => {
    expect(aiConnectionFromWire([], false)).toEqual(NO_AI_CONNECTION)
    expect(aiConnectionFromWire([], undefined)).toEqual(NO_AI_CONNECTION)
  })

  it('reads a named client as connected even without the flag', () => {
    expect(aiConnectionFromWire(['claude'], undefined)).toEqual({ connected: true, clients: ['claude'] })
  })
})

describe('unknownAgentOnly', () => {
  it('is true only when an agent is connected and none of the three is named', () => {
    expect(unknownAgentOnly(aiConnection([{ client: null }]))).toBe(true)
    expect(unknownAgentOnly(aiConnection([{ client: 'cursor' }, { client: 'local' }]))).toBe(true)
    expect(unknownAgentOnly(aiConnection([{ client: null }, { client: 'claude' }]))).toBe(false)
    expect(unknownAgentOnly(aiConnection([]))).toBe(false)
  })
})

describe('agentChipView', () => {
  it('offers the three clients to connect while nothing is connected', () => {
    expect(agentChipView(NO_AI_CONNECTION)).toEqual({ on: false, logos: ['claude', 'chatgpt', 'grok'], named: [] })
  })

  it('reads a key with no known client as a generic connected agent: on, no logo, no name', () => {
    expect(agentChipView(aiConnection([{ client: null }]))).toEqual({ on: true, logos: [], named: [] })
    expect(agentChipView(aiConnection([{ client: 'local' }]))).toEqual({ on: true, logos: [], named: [] })
  })

  it('keeps the known clients\' logos and names when connected', () => {
    expect(agentChipView(aiConnection([{ client: 'claude' }, { client: null }]))).toEqual({
      on: true,
      logos: ['claude'],
      named: ['claude'],
    })
  })
})

describe('aiChatLink', () => {
  it.each([
    ['claude', 'https://claude.ai/new'],
    ['chatgpt', 'https://chatgpt.com/'],
    ['grok', 'https://grok.com/'],
  ] as const)('opens %s without putting task or company data in the URL', (client, expected) => {
    const link = aiChatLink(client)
    expect(link).toBe(expected)
    expect(new URL(link).search).toBe('')
    expect(new URL(link).hash).toBe('')
  })
})

describe('pickConnectedAiClient', () => {
  it('hands off to the client just connected even when another was already connected', () => {
    expect(pickConnectedAiClient(['claude', 'chatgpt'], 'chatgpt')).toBe('chatgpt')
  })

  it('never treats a connect click as a completed authorization', () => {
    expect(pickConnectedAiClient([], 'grok')).toBeNull()
    expect(pickConnectedAiClient(['claude'], 'grok')).toBe('claude')
  })

  it('falls back to display order if the preferred connection is revoked', () => {
    expect(pickConnectedAiClient(['grok', 'chatgpt'], 'claude')).toBe('chatgpt')
  })
})

describe('aiConnectAction', () => {
  const input = { origin: 'https://app.testbrand.example', appName: 'Testbrand' }

  it('Claude gets the prefilled add-connector deep link and nothing to copy', () => {
    const a = aiConnectAction('claude', input)
    expect(a.open).toContain('https://claude.ai/customize/connectors?modal=add-custom-connector')
    expect(a.open).toContain(encodeURIComponent('https://app.testbrand.example/api/extensions/ext/mcp-server/mcp'))
    expect(a.copy).toBeNull()
  })

  it('ChatGPT and Grok copy the server URL and open their connector page (Grok: grok.com/connectors, where New Connector lives)', () => {
    const chatgpt = aiConnectAction('chatgpt', input)
    expect(chatgpt.open).toBe('https://chatgpt.com/#settings/Connectors')
    expect(chatgpt.copy).toContain('/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=chatgpt')
    const grok = aiConnectAction('grok', input)
    expect(grok.open).toBe('https://grok.com/connectors')
    expect(grok.copy).toContain('client=grok&auth=required')
  })
})

describe('aiPrefilledChatLink', () => {
  it('opens each client on a new chat with the prompt in q', () => {
    const prompt = `Ladda skillen "${kvittojaktenSkillSlug('claude')}" & följ den`
    expect(aiPrefilledChatLink('claude', prompt)).toBe(
      'https://claude.ai/new?q=Ladda%20skillen%20%22kvittojakten-claude%22%20%26%20f%C3%B6lj%20den',
    )
    expect(aiPrefilledChatLink('chatgpt', 'x')).toBe('https://chatgpt.com/?q=x')
    expect(aiPrefilledChatLink('grok', 'x')).toBe('https://grok.com/?q=x')
  })

  it('names a skill per client', () => {
    expect(kvittojaktenSkillSlug('chatgpt')).toBe('kvittojakten-chatgpt')
    expect(kvittojaktenSkillSlug('grok')).toBe('kvittojakten-grok')
  })
})
