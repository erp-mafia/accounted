import { SCOPE_GROUPS, type ApiKeyScope, type ScopeGroup } from '@/lib/auth/scope-catalog'

/**
 * How API-key scopes are named in settings (namespace settings_api_keys).
 * Shared by the scope picker for a new key (ApiKeysPanel) and the
 * permission summary on a connection row (McpConnectionsPanel), so a scope
 * reads the same where it is granted and where it is shown afterwards.
 */

/** i18n key for a scope card: `scope_<domain>_<verb>`. */
export const scopeLabelKey = (scope: ApiKeyScope) => `scope_${scope.replace(':', '_')}`

/** i18n key for a group heading: `group_<domain>`. */
export const groupLabelKey = (group: ScopeGroup) => `group_${group.domain}`

/** Verb of a scope card label ("Skriv: skapa ..." -> "Skriv"). */
export function scopeVerb(label: string): string {
  const sepIdx = label.indexOf(': ')
  return sepIdx > 0 ? label.slice(0, sepIdx) : label
}

/**
 * The scopes a key holds, per group, in the picker's order. Groups the key
 * holds nothing in are left out, and so is any stored scope the catalogue
 * no longer knows: there is no label to show for it.
 */
export function grantedScopeGroups(
  scopes: readonly string[],
): { group: ScopeGroup; scopes: ApiKeyScope[] }[] {
  const held = new Set(scopes)
  return SCOPE_GROUPS.flatMap((group) => {
    const granted = group.scopes.filter((scope) => held.has(scope))
    return granted.length > 0 ? [{ group, scopes: granted }] : []
  })
}
