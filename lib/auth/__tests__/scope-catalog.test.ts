import { describe, expect, it } from 'vitest'
import {
  ALL_SCOPES,
  API_KEY_SCOPES,
  SCOPE_GROUPS,
  TOOL_COUNT_BY_SCOPE,
  TOOL_SCOPE_MAP,
  scopeKind,
  type ApiKeyScope,
} from '../scope-catalog'
import * as apiKeys from '../api-keys'

describe('SCOPE_GROUPS', () => {
  it('covers every scope in API_KEY_SCOPES exactly once', () => {
    const occurrences = new Map<ApiKeyScope, number>()
    for (const group of SCOPE_GROUPS) {
      for (const scope of group.scopes) {
        occurrences.set(scope, (occurrences.get(scope) ?? 0) + 1)
      }
    }
    const missing = ALL_SCOPES.filter((s) => !occurrences.has(s))
    const duplicated = [...occurrences].filter(([, n]) => n > 1).map(([s]) => s)
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])
  })

  it('only references scopes that exist in the catalogue', () => {
    for (const group of SCOPE_GROUPS) {
      for (const scope of group.scopes) {
        expect(scope in API_KEY_SCOPES).toBe(true)
      }
    }
  })

  it('has unique domains and lists the read scope first', () => {
    const domains = SCOPE_GROUPS.map((g) => g.domain)
    expect(new Set(domains).size).toBe(domains.length)
    for (const group of SCOPE_GROUPS) {
      const readIndex = group.scopes.findIndex((s) => scopeKind(s) === 'read')
      if (readIndex !== -1) expect(readIndex).toBe(0)
    }
  })
})

describe('TOOL_COUNT_BY_SCOPE', () => {
  it('has an entry for every scope and none for anything else', () => {
    expect(Object.keys(TOOL_COUNT_BY_SCOPE).sort()).toEqual([...ALL_SCOPES].sort())
  })

  it('equals the number of TOOL_SCOPE_MAP entries mapped to each scope', () => {
    for (const scope of ALL_SCOPES) {
      const expected = Object.values(TOOL_SCOPE_MAP).filter((s) => s === scope).length
      expect(TOOL_COUNT_BY_SCOPE[scope], scope).toBe(expected)
    }
    const total = Object.values(TOOL_COUNT_BY_SCOPE).reduce((a, b) => a + b, 0)
    expect(total).toBe(Object.keys(TOOL_SCOPE_MAP).length)
  })

  it('only maps tools to scopes that exist', () => {
    for (const [tool, scope] of Object.entries(TOOL_SCOPE_MAP)) {
      expect(scope in API_KEY_SCOPES, tool).toBe(true)
    }
  })
})

describe('API_KEY_SCOPES labels', () => {
  it('carries no hand-written tool counts (they are derived)', () => {
    for (const [scope, meta] of Object.entries(API_KEY_SCOPES)) {
      expect(meta.description, scope).not.toMatch(/\(\d+ verktyg\)/)
      expect(meta.label, scope).not.toMatch(/\(\d+ verktyg\)/)
    }
  })

  it('formats every label as "Område: verb"', () => {
    for (const meta of Object.values(API_KEY_SCOPES)) {
      expect(meta.label).toMatch(/^[^:]+: .+$/)
    }
  })
})

describe('scopeKind', () => {
  it('treats :read as read and everything else as an elevated grant', () => {
    expect(scopeKind('transactions:read')).toBe('read')
    expect(scopeKind('transactions:write')).toBe('write')
    expect(scopeKind('webhooks:manage')).toBe('write')
    expect(scopeKind('pending_operations:approve')).toBe('write')
    expect(scopeKind('reconciliation:signoff')).toBe('write')
  })
})

describe('api-keys re-exports', () => {
  it('exposes the same catalogue objects so server imports keep working', () => {
    expect(apiKeys.API_KEY_SCOPES).toBe(API_KEY_SCOPES)
    expect(apiKeys.SCOPE_GROUPS).toBe(SCOPE_GROUPS)
    expect(apiKeys.TOOL_SCOPE_MAP).toBe(TOOL_SCOPE_MAP)
    expect(apiKeys.TOOL_COUNT_BY_SCOPE).toBe(TOOL_COUNT_BY_SCOPE)
    expect(apiKeys.ALL_SCOPES).toBe(ALL_SCOPES)
  })
})
