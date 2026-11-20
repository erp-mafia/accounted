import { ALL_SCOPES, scopeKind, type ApiKeyScope, type ScopeGroup } from '@/lib/auth/scope-catalog'

/**
 * Scope picker state for a new API key (ApiKeysPanel). Pure, so the rules
 * below are tested without rendering the dialog.
 *
 * An elevated scope (write, approve, signoff) needs the group's read scope:
 * ticking one ticks read too, and read stays ticked, locked in the panel,
 * while any elevated scope in its group is ticked. It used to be unlockable,
 * and unticking it silently cleared the whole group; people who wanted write
 * without read clicked the two cards back and forth (PostHog, /settings/api).
 * The reachable combinations are the same as before: never elevated without
 * read.
 */

/** The group's read scope, if it has one (bookkeeping and skatteverket do not). */
export function readScopeOf(group: ScopeGroup): ApiKeyScope | undefined {
  return group.scopes.find((scope) => scopeKind(scope) === 'read')
}

/** The ticked elevated scopes that keep the group's read scope ticked. */
export function readLockedBy(selected: ReadonlySet<ApiKeyScope>, group: ScopeGroup): ApiKeyScope[] {
  const read = readScopeOf(group)
  if (!read) return []
  return group.scopes.filter((scope) => scope !== read && selected.has(scope))
}

/** The selection after ticking or unticking one scope card. */
export function toggleScope(
  selected: ReadonlySet<ApiKeyScope>,
  group: ScopeGroup,
  scope: ApiKeyScope,
  checked: boolean,
): Set<ApiKeyScope> {
  const next = new Set(selected)
  const read = readScopeOf(group)
  if (checked) {
    next.add(scope)
    if (read) next.add(read)
  } else if (!(scope === read && readLockedBy(selected, group).length > 0)) {
    next.delete(scope)
  }
  return next
}

/** One-click starting points: everything, every read scope, nothing. */
export type ScopePreset = 'all' | 'read_only' | 'none'

export function presetScopes(preset: ScopePreset): Set<ApiKeyScope> {
  if (preset === 'all') return new Set(ALL_SCOPES)
  if (preset === 'read_only') return new Set(ALL_SCOPES.filter((scope) => scopeKind(scope) === 'read'))
  return new Set()
}
