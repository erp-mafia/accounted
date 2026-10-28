import { describe, expect, it } from 'vitest'
import {
  clientInfoNameFromMeta,
  clientLabelForName,
  clientLabelForOAuthProvider,
  clientTelemetryFields,
  parseClientMarker,
  resolveClientLabel,
  sanitizeClientName,
} from '../client-label'

describe('parseClientMarker', () => {
  it('keeps the existing marker rule: charset, length, lowercased', () => {
    expect(parseClientMarker('Claude-Connector')).toBe('claude-connector')
    expect(parseClientMarker('openclaw')).toBe('openclaw')
    expect(parseClientMarker('bad client!<script>')).toBeNull()
    expect(parseClientMarker('x'.repeat(65))).toBeNull()
    expect(parseClientMarker('')).toBeNull()
    expect(parseClientMarker(null)).toBeNull()
  })
})

describe('sanitizeClientName', () => {
  it('keeps letters, digits and .-_/ space, collapses whitespace and trims', () => {
    expect(sanitizeClientName('python-httpx/0.28.1')).toBe('python-httpx/0.28.1')
    expect(sanitizeClientName('  My  Agent\t(v2); <b>x</b>  ')).toBe('My Agent v2 b x /b')
    expect(sanitizeClientName('n8n "workflow" #12')).toBe('n8n workflow 12')
  })

  it('caps the name at 64 characters', () => {
    const name = sanitizeClientName(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)`)
    expect(name).not.toBeNull()
    expect((name as string).length).toBeLessThanOrEqual(64)
    expect(name).toMatch(/^[A-Za-z0-9._/ -]+$/)
  })

  it('drops non-ASCII letters and control characters', () => {
    expect(sanitizeClientName('Åsa\u0000‮bot')).toBe('sa bot')
  })

  it('returns null when nothing usable is left or the value is not a string', () => {
    expect(sanitizeClientName('!!!<>')).toBeNull()
    expect(sanitizeClientName('   ')).toBeNull()
    expect(sanitizeClientName(42)).toBeNull()
    expect(sanitizeClientName(undefined)).toBeNull()
  })
})

describe('clientLabelForName', () => {
  it('maps known clientInfo names and User-Agents into the marker vocabulary', () => {
    expect(clientLabelForName('claude-code/2.0.14')).toBe('claude-code')
    expect(clientLabelForName('claude-cli/1.0.0 (external, cli)')).toBe('claude-code')
    expect(clientLabelForName('Claude-Desktop')).toBe('claude-desktop')
    expect(clientLabelForName('claude-ai')).toBe('claude-connector')
    expect(clientLabelForName('Claude-User/1.0')).toBe('claude-connector')
    expect(clientLabelForName('openai-mcp/1.0.0')).toBe('chatgpt')
    expect(clientLabelForName('ChatGPT')).toBe('chatgpt')
    expect(clientLabelForName('codex-mcp-client')).toBe('codex')
    expect(clientLabelForName('cursor-vscode')).toBe('cursor')
    expect(clientLabelForName('Gemini-CLI/0.9')).toBe('gemini')
    expect(clientLabelForName('grok')).toBe('grok')
    expect(clientLabelForName('Visual Studio Code')).toBe('vscode')
  })

  it('finds a product token later in a browser-style User-Agent', () => {
    expect(clientLabelForName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Cursor/1.7.2 Chrome/132.0')).toBe('cursor')
  })

  it('returns null for a name outside the vocabulary', () => {
    expect(clientLabelForName('node')).toBeNull()
    expect(clientLabelForName('python-httpx/0.28.1')).toBeNull()
    expect(clientLabelForName('claude-something-else')).toBeNull()
    expect(clientLabelForName('')).toBeNull()
  })
})

describe('clientLabelForOAuthProvider', () => {
  it('maps the stored OAuth providers and lets the uninformative ones fall through', () => {
    expect(clientLabelForOAuthProvider('claude')).toBe('claude-connector')
    expect(clientLabelForOAuthProvider('chatgpt')).toBe('chatgpt')
    expect(clientLabelForOAuthProvider('grok')).toBe('grok')
    expect(clientLabelForOAuthProvider('gemini')).toBe('gemini')
    expect(clientLabelForOAuthProvider('cursor')).toBe('cursor')
    expect(clientLabelForOAuthProvider('cursor_deeplink')).toBe('cursor')
    expect(clientLabelForOAuthProvider('local')).toBeNull()
    expect(clientLabelForOAuthProvider('registered:6f1c2c4e-0000-4000-8000-000000000000')).toBeNull()
    expect(clientLabelForOAuthProvider(null)).toBeNull()
  })
})

describe('clientInfoNameFromMeta', () => {
  it('reads clientInfo.name from a stateless request _meta', () => {
    expect(clientInfoNameFromMeta({ 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.0.0' } })).toBe('claude-code')
    expect(clientInfoNameFromMeta({ 'io.modelcontextprotocol/clientInfo': { version: '1' } })).toBeNull()
    expect(clientInfoNameFromMeta({ 'io.modelcontextprotocol/clientInfo': 'claude' })).toBeNull()
    expect(clientInfoNameFromMeta(undefined)).toBeNull()
  })
})

describe('resolveClientLabel', () => {
  it('keeps a valid marker exactly as before, ignoring every fallback', () => {
    expect(resolveClientLabel({ marker: 'Claude-Desktop', oauthProvider: 'chatgpt', clientInfoName: 'cursor', userAgent: 'node' }))
      .toEqual({ client: 'claude-desktop', clientName: null, clientSource: null })
    expect(resolveClientLabel({ marker: 'other', userAgent: 'claude-code/2.0.0' }))
      .toEqual({ client: 'other', clientName: null, clientSource: null })
  })

  it('falls back to the OAuth provider, then clientInfo, then the User-Agent', () => {
    expect(resolveClientLabel({ marker: null, oauthProvider: 'chatgpt', clientInfoName: 'cursor', userAgent: 'node' }))
      .toEqual({ client: 'chatgpt', clientName: null, clientSource: 'oauth' })
    expect(resolveClientLabel({ marker: null, oauthProvider: 'local', clientInfoName: 'claude-code', userAgent: 'node' }))
      .toEqual({ client: 'claude-code', clientName: null, clientSource: 'client_info' })
    expect(resolveClientLabel({ marker: 'bad client!', oauthProvider: null, userAgent: 'openai-mcp/1.0.0' }))
      .toEqual({ client: 'chatgpt', clientName: null, clientSource: 'user_agent' })
  })

  it('labels an unmapped name other, with the sanitized raw name', () => {
    expect(resolveClientLabel({ marker: null, userAgent: 'python-httpx/0.28.1' }))
      .toEqual({ client: 'other', clientName: 'python-httpx/0.28.1', clientSource: 'user_agent' })
    expect(resolveClientLabel({ marker: null, clientInfoName: 'My <Agent>', userAgent: 'node' }))
      .toEqual({ client: 'other', clientName: 'My Agent', clientSource: 'client_info' })
  })

  it('labels a request with no source at all other, source none', () => {
    expect(resolveClientLabel({ marker: null, userAgent: null }))
      .toEqual({ client: 'other', clientName: null, clientSource: 'none' })
    expect(resolveClientLabel({ marker: undefined, userAgent: '   ' }))
      .toEqual({ client: 'other', clientName: null, clientSource: 'none' })
  })
})

describe('clientTelemetryFields', () => {
  it('leaves clientName and clientSource out of a marker-labelled row', () => {
    expect(clientTelemetryFields({ client: 'claude-connector', clientName: null, clientSource: null }))
      .toEqual({ client: 'claude-connector' })
    expect(clientTelemetryFields({})).toEqual({ client: null })
  })

  it('carries them when a fallback set the label', () => {
    expect(clientTelemetryFields({ client: 'other', clientName: 'node', clientSource: 'user_agent' }))
      .toEqual({ client: 'other', clientName: 'node', clientSource: 'user_agent' })
  })
})
