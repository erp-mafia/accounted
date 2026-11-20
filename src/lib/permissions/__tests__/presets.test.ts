/**
 * The catalog and the role presets: twelve permissions with copy in both
 * languages, presets that reproduce today's roles, overrides that only
 * narrow, and the API role ceiling (capScopesForRole) expressed by the
 * scope doors.
 */
import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'
import { capScopesForRole } from '@/lib/auth/oauth-allowlist'
import { INVOICER_API_SCOPES } from '@/lib/auth/invoicer-role'
import { ALL_SCOPES, scopeKind } from '@/lib/auth/scope-catalog'
import type { CompanyRole } from '@/types'
import { PERMISSION_CATALOG, PERMISSIONS, isPermission, permissionMessageKey } from '../catalog'
import { SCOPE_DOORS } from '../doors'
import { ROLE_PRESETS, effectivePersonPermissions, presetHas } from '../presets'

const ROLES: CompanyRole[] = ['owner', 'admin', 'member', 'viewer', 'invoicer']

function message(messages: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages)
}

describe('permission catalog', () => {
  it('has the twelve permissions, each defined once under its own id', () => {
    expect(PERMISSIONS).toHaveLength(12)
    expect(new Set(PERMISSIONS).size).toBe(12)
    expect(Object.keys(PERMISSION_CATALOG).sort()).toEqual([...PERMISSIONS].sort())
    for (const p of PERMISSIONS) expect(PERMISSION_CATALOG[p].id).toBe(p)
    expect(isPermission('bookkeeping.write')).toBe(true)
    expect(isPermission('bookkeeping:write')).toBe(false)
  })

  it('keeps members, settings and agents.autonomy from every agent, and nothing else', () => {
    const neverForAgents = PERMISSIONS.filter((p) => !PERMISSION_CATALOG[p].agentMayHold).sort()
    expect(neverForAgents).toEqual(['agents.autonomy', 'members', 'settings'])
  })

  it('has a label and a description in Swedish and English', () => {
    for (const p of PERMISSIONS) {
      const { labelKey, descriptionKey } = PERMISSION_CATALOG[p]
      expect(labelKey).toBe(`permissions.${permissionMessageKey(p)}.label`)
      for (const messages of [sv, en]) {
        expect(typeof message(messages, labelKey), `${labelKey}`).toBe('string')
        expect(typeof message(messages, descriptionKey), `${descriptionKey}`).toBe('string')
      }
    }
    expect(message(sv, 'permissions.bookkeeping_read.label')).toBe('Läsa bokföring och rapporter')
    expect(message(sv, 'permissions.agents_autonomy.label')).toBe('Ge agenter Gör själv')
    expect(Object.keys(message(sv, 'permissions') as object).sort()).toEqual(Object.keys(message(en, 'permissions') as object).sort())
  })

  it('says plainly that ledger totals stay visible without payroll.read', () => {
    expect(message(sv, PERMISSION_CATALOG['payroll.read'].descriptionKey)).toMatch(/bokföringen syns ändå/)
  })
})

describe('role presets', () => {
  it('gives owner and admin everything', () => {
    for (const role of ['owner', 'admin'] as const) expect([...ROLE_PRESETS[role]].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('gives a member everything but who-may-do-what and the company settings', () => {
    const missing = PERMISSIONS.filter((p) => !presetHas('member', p)).sort()
    expect(missing).toEqual(['agents.autonomy', 'members', 'settings'])
  })

  it('gives a viewer reading and connecting, an invoicer invoicing and connecting', () => {
    expect([...ROLE_PRESETS.viewer].sort()).toEqual(['agents.connect', 'bookkeeping.read', 'payroll.read'])
    expect([...ROLE_PRESETS.invoicer].sort()).toEqual(['agents.connect', 'invoicing'])
  })

  it('lets overrides narrow, never widen, with agents.autonomy for a member as the one extra', () => {
    expect(effectivePersonPermissions('member', { invoicing: false }).has('invoicing')).toBe(false)
    expect(effectivePersonPermissions('admin', { members: false }).has('members')).toBe(false)
    expect(effectivePersonPermissions('viewer', { 'bookkeeping.write': true }).has('bookkeeping.write')).toBe(false)
    expect(effectivePersonPermissions('member', { settings: true }).has('settings')).toBe(false)
    expect(effectivePersonPermissions('member', { 'agents.autonomy': true }).has('agents.autonomy')).toBe(true)
    expect(effectivePersonPermissions('viewer', { 'agents.autonomy': true }).has('agents.autonomy')).toBe(false)
    expect(effectivePersonPermissions('invoicer', { 'agents.autonomy': true }).has('agents.autonomy')).toBe(false)
  })

  it('keeps everything for the owner, whatever the overrides say', () => {
    expect(effectivePersonPermissions('owner', { members: false, settings: false }).size).toBe(PERMISSIONS.length)
  })

  it('gives an unknown or missing role nothing', () => {
    expect(effectivePersonPermissions(null).size).toBe(0)
    expect(effectivePersonPermissions(undefined).size).toBe(0)
    expect(effectivePersonPermissions('superuser').size).toBe(0)
    expect(effectivePersonPermissions('constructor').size).toBe(0)
  })

  it('without overrides is exactly the preset', () => {
    for (const role of ROLES) expect([...effectivePersonPermissions(role)].sort()).toEqual([...ROLE_PRESETS[role]].sort())
  })
})

describe('the API role ceiling through the scope doors', () => {
  // capScopesForRole caps what a key minted for a viewer or an invoicer may
  // hold. A scope's door is covered by the role's preset exactly when the
  // role may hold the scope today. Owner, admin and member hold every scope
  // today; where a member's key holds one whose door needs settings or
  // members (companies:write, service_accounts:manage), the door itself
  // checks for an owner or admin, as it does today.
  const coveredBy = (role: CompanyRole, scope: (typeof ALL_SCOPES)[number]): boolean => {
    const door = SCOPE_DOORS[scope]
    if (!door) return false
    return presetHas(role, door.permission) || (door.orPermission !== undefined && presetHas(role, door.orPermission))
  }

  it.each(['viewer', 'invoicer'] as const)('matches capScopesForRole for a %s', (role) => {
    const held = new Set(capScopesForRole(ALL_SCOPES, role))
    for (const scope of ALL_SCOPES) {
      if (SCOPE_DOORS[scope] === null) continue // approving: decided per staged operation
      expect(coveredBy(role, scope), `${role} ${scope}`).toBe(held.has(scope))
    }
  })

  it('reads every read scope, so a viewer holds them all', () => {
    for (const scope of ALL_SCOPES) {
      if (scopeKind(scope) === 'read') expect(SCOPE_DOORS[scope]?.effect, scope).toBe('read')
    }
  })

  it('gives the invoicer exactly its scopes', () => {
    const covered = ALL_SCOPES.filter((s) => coveredBy('invoicer', s)).sort()
    expect(covered).toEqual([...INVOICER_API_SCOPES].sort())
  })
})
