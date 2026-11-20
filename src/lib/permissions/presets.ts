/**
 * What a person may do in a company: their role's preset, narrowed by
 * overrides.
 *
 * The presets reproduce today's role gates exactly, so no one gains or
 * loses anything until an override row says so
 * (__tests__/preset-equivalence.test.ts compares every dashboard write
 * route's gate with them):
 *   - owner and admin: everything.
 *   - member: what requireWrite lets a non-viewer do, plus reading payroll
 *     and connecting agents; not members, settings or agents.autonomy, which
 *     only an owner or admin decides today (requireAdmin, the grant and
 *     invite routes).
 *   - viewer: reading, payroll included, and connecting agents (a viewer
 *     connects OAuth with read scopes: capScopesForRole in
 *     lib/auth/oauth-allowlist.ts).
 *   - invoicer: invoicing and connecting agents with the invoicing scopes
 *     (lib/auth/invoicer-role.ts).
 *
 * Overrides only narrow, with one opt-in extra: agents.autonomy for a
 * member. The owner always holds everything.
 */
import type { CompanyRole } from '@/types'
import { PERMISSIONS, type Permission } from './catalog'

const ALL: readonly Permission[] = PERMISSIONS

export const ROLE_PRESETS: Readonly<Record<CompanyRole, readonly Permission[]>> = Object.freeze({
  owner: ALL,
  admin: ALL,
  member: Object.freeze([
    'bookkeeping.read',
    'bookkeeping.write',
    'invoicing',
    'payments.prepare',
    'payroll.read',
    'payroll.write',
    'tax.prepare',
    'periods',
    'agents.connect',
  ] satisfies Permission[]),
  viewer: Object.freeze(['bookkeeping.read', 'payroll.read', 'agents.connect'] satisfies Permission[]),
  invoicer: Object.freeze(['invoicing', 'agents.connect'] satisfies Permission[]),
})

/** The only permission an override may add, and the role it may be added to. */
const OPT_IN_EXTRA: { permission: Permission; role: CompanyRole } = { permission: 'agents.autonomy', role: 'member' }

/**
 * A person's override rows for one company: false takes a permission away,
 * true adds the opt-in extra. Any other true is ignored: overrides never
 * widen a preset.
 */
export type PermissionOverrides = Partial<Record<Permission, boolean>>

function isCompanyRole(role: string): role is CompanyRole {
  return Object.hasOwn(ROLE_PRESETS, role)
}

/**
 * The permissions a person holds in a company. An unknown or missing role
 * holds nothing: an unrecognised privilege level never widens access.
 */
export function effectivePersonPermissions(
  role: string | null | undefined,
  overrides: PermissionOverrides = {},
): ReadonlySet<Permission> {
  if (!role || !isCompanyRole(role)) return new Set()
  if (role === 'owner') return new Set(ALL)
  const held = new Set<Permission>(ROLE_PRESETS[role])
  for (const [permission, value] of Object.entries(overrides) as Array<[Permission, boolean | undefined]>) {
    if (value === false) held.delete(permission)
    else if (value === true && permission === OPT_IN_EXTRA.permission && role === OPT_IN_EXTRA.role) held.add(permission)
  }
  return held
}

/** Does the role's preset, with no overrides, hold the permission? */
export function presetHas(role: CompanyRole, permission: Permission): boolean {
  return ROLE_PRESETS[role].includes(permission)
}
