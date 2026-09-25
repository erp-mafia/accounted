import { describe, it, expect } from 'vitest'
import { connectionKind, isStaleConnection, STALE_AFTER_DAYS } from '../mcp-connections'

describe('connectionKind', () => {
  it('labels manual keys as keys whatever the client column says', () => {
    expect(connectionKind({ source: 'manual', client: null })).toBe('key')
    expect(connectionKind({ source: 'manual', client: 'claude' })).toBe('key')
    expect(connectionKind({ client: 'claude' })).toBe('key')
  })

  it('maps built-in sign-in clients', () => {
    expect(connectionKind({ source: 'signin', client: 'claude' })).toBe('claude')
    expect(connectionKind({ source: 'signin', client: 'chatgpt' })).toBe('chatgpt')
    expect(connectionKind({ source: 'signin', client: 'grok' })).toBe('grok')
    expect(connectionKind({ source: 'signin', client: 'local' })).toBe('local')
  })

  it('folds both Cursor redirect shapes into cursor', () => {
    expect(connectionKind({ source: 'signin', client: 'cursor' })).toBe('cursor')
    expect(connectionKind({ source: 'signin', client: 'cursor_deeplink' })).toBe('cursor')
  })

  it('falls back to a generic MCP client for null or unknown clients', () => {
    expect(connectionKind({ source: 'signin', client: null })).toBe('mcp')
    expect(connectionKind({ source: 'signin', client: 'something-new' })).toBe('mcp')
  })
})

describe('isStaleConnection', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString()

  it('is stale once last use is STALE_AFTER_DAYS old', () => {
    expect(isStaleConnection({ last_used_at: daysAgo(STALE_AFTER_DAYS), created_at: daysAgo(400) }, now)).toBe(true)
    expect(isStaleConnection({ last_used_at: daysAgo(STALE_AFTER_DAYS - 1), created_at: daysAgo(400) }, now)).toBe(false)
  })

  it('counts a never-used row from its creation date', () => {
    expect(isStaleConnection({ last_used_at: null, created_at: daysAgo(3) }, now)).toBe(false)
    expect(isStaleConnection({ last_used_at: null, created_at: daysAgo(120) }, now)).toBe(true)
  })

  it('never flags a row with an unparseable date', () => {
    expect(isStaleConnection({ last_used_at: null, created_at: 'not a date' }, now)).toBe(false)
  })
})
