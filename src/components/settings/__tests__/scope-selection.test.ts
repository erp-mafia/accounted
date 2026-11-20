import { describe, it, expect } from 'vitest'
import { ALL_SCOPES, SCOPE_GROUPS, scopeKind, type ApiKeyScope, type ScopeGroup } from '@/lib/auth/scope-catalog'
import { presetScopes, readLockedBy, readScopeOf, toggleScope } from '../scope-selection'

/**
 * The API key scope picker (/settings/api). People who wanted write without
 * read clicked the two cards back and forth: unticking read silently cleared
 * the whole group, ticking write silently ticked read again. Read now stays
 * ticked, locked with a reason, while an elevated scope holds it; the set of
 * reachable selections is unchanged (never elevated without read).
 */
function group(domain: string): ScopeGroup {
  const found = SCOPE_GROUPS.find((g) => g.domain === domain)
  if (!found) throw new Error(`no scope group ${domain}`)
  return found
}

const invoices = group('invoices')
const reconciliation = group('reconciliation')
const bookkeeping = group('bookkeeping')

/** No group holds an elevated scope without its read scope. */
function respectsReadImplication(selected: ReadonlySet<ApiKeyScope>): boolean {
  return SCOPE_GROUPS.every((g) => {
    const read = readScopeOf(g)
    return !read || readLockedBy(selected, g).length === 0 || selected.has(read)
  })
}

describe('toggleScope', () => {
  it('ticks the group read scope with an elevated one', () => {
    const next = toggleScope(new Set(), invoices, 'invoices:write', true)
    expect([...next].sort()).toEqual(['invoices:read', 'invoices:write'])
  })

  it('keeps read ticked while write holds it (the click is a no-op)', () => {
    const start = new Set<ApiKeyScope>(['invoices:read', 'invoices:write'])
    const next = toggleScope(start, invoices, 'invoices:read', false)
    expect(next).toEqual(start)
  })

  it('unticks read once nothing elevated in the group is ticked', () => {
    let s = toggleScope(new Set(['invoices:read', 'invoices:write']), invoices, 'invoices:write', false)
    expect([...s]).toEqual(['invoices:read'])
    s = toggleScope(s, invoices, 'invoices:read', false)
    expect(s.size).toBe(0)
  })

  it('leaves other groups alone', () => {
    const start = new Set<ApiKeyScope>(['customers:read', 'invoices:read'])
    const next = toggleScope(start, invoices, 'invoices:read', false)
    expect([...next]).toEqual(['customers:read'])
  })

  it('a group without a read scope toggles freely', () => {
    expect(readScopeOf(bookkeeping)).toBeUndefined()
    const on = toggleScope(new Set(), bookkeeping, 'bookkeeping:write', true)
    expect([...on]).toEqual(['bookkeeping:write'])
    expect(toggleScope(on, bookkeeping, 'bookkeeping:write', false).size).toBe(0)
  })

  it('never reaches an elevated scope without read, from any card in any order', () => {
    let s = presetScopes('all')
    for (const g of SCOPE_GROUPS) {
      for (const scope of g.scopes) {
        s = toggleScope(s, g, scope, !s.has(scope))
        expect(respectsReadImplication(s)).toBe(true)
        s = toggleScope(s, g, scope, !s.has(scope))
        expect(respectsReadImplication(s)).toBe(true)
      }
    }
  })
})

describe('readLockedBy', () => {
  it('names every ticked elevated scope holding read', () => {
    const s = new Set<ApiKeyScope>(['reconciliation:read', 'reconciliation:write', 'reconciliation:signoff'])
    expect(readLockedBy(s, reconciliation)).toEqual(['reconciliation:write', 'reconciliation:signoff'])
    expect(readLockedBy(new Set(['reconciliation:read']), reconciliation)).toEqual([])
  })
})

describe('presetScopes', () => {
  it('"Välj alla" is every scope, "Rensa" is none', () => {
    expect([...presetScopes('all')].sort()).toEqual([...ALL_SCOPES].sort())
    expect(presetScopes('none').size).toBe(0)
  })

  it('"Bara läsa" is exactly the read scopes', () => {
    const readOnly = presetScopes('read_only')
    expect(readOnly.size).toBeGreaterThan(0)
    for (const scope of ALL_SCOPES) expect(readOnly.has(scope)).toBe(scopeKind(scope) === 'read')
  })

  it('every preset respects the read implication', () => {
    for (const preset of ['all', 'read_only', 'none'] as const) {
      expect(respectsReadImplication(presetScopes(preset))).toBe(true)
    }
  })
})
