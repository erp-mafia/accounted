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
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

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

describe('SIE intake scopes', () => {
  it('lets a read key stage and preflight a file, and keeps the ledger write behind bookkeeping:write', () => {
    expect(TOOL_SCOPE_MAP.gnubok_sie_preflight).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_create_sie_upload).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_sie_import_status).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_import_sie).toBe('bookkeeping:write')
    expect(TOOL_SCOPE_MAP.gnubok_undo_sie_import).toBe('bookkeeping:write')
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

describe('pending_operations labels (issue #3408)', () => {
  // The scopes behind the review list are named after it ("Agentförslag"
  // under Att göra) on every surface that shows them: the consent page reads
  // API_KEY_SCOPES and SCOPE_GROUPS, the API key dialog reads the messages.
  it('names the scopes and their group Agentförslag in the catalogue', () => {
    expect(API_KEY_SCOPES['pending_operations:read'].label).toBe('Agentförslag: läs')
    expect(API_KEY_SCOPES['pending_operations:approve'].label).toBe('Agentförslag: godkänn')
    expect(SCOPE_GROUPS.find((g) => g.domain === 'pending_operations')?.label).toBe('Agentförslag')
  })

  it('names the group Agentförslag / Agent proposals in the API key dialog', () => {
    expect(sv.settings_api_keys.group_pending_operations).toBe('Agentförslag')
    expect(en.settings_api_keys.group_pending_operations).toBe('Agent proposals')
  })

  // Scope: every label, the Agentförslag descriptions and the SoD dialog copy.
  // Other scopes' descriptions still say "stagas"; rewording those is a
  // follow-up outside issue #3408.
  it('leaves no staging jargon in the scope labels, the Agentförslag copy or the SoD dialog copy', () => {
    for (const [scope, meta] of Object.entries(API_KEY_SCOPES)) {
      expect(meta.label, scope).not.toMatch(/stagade operationer/i)
    }
    for (const scope of ['pending_operations:read', 'pending_operations:approve'] as const) {
      expect(API_KEY_SCOPES[scope].description, scope).not.toMatch(/stag|pending_operations|committa/i)
    }
    expect(SCOPE_GROUPS.map((g) => g.label)).not.toContain('Stagade operationer')
    const svKeys = sv.settings_api_keys
    const enKeys = en.settings_api_keys
    for (const text of [
      svKeys.scope_pending_operations_read,
      svKeys.scope_pending_operations_approve,
      svKeys.sod_warning,
      svKeys.sod_dialog_description,
    ]) {
      expect(text).not.toMatch(/stag|pending_operations|committa/i)
    }
    for (const text of [
      enKeys.scope_pending_operations_read,
      enKeys.scope_pending_operations_approve,
      enKeys.sod_warning,
      enKeys.sod_dialog_description,
    ]) {
      expect(text).not.toMatch(/stag|pending_operations/i)
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
