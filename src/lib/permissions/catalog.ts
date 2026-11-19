/**
 * Permissions (behörigheter): the one vocabulary for what a person, and an
 * agent acting for a person, may do in a company.
 *
 * A person holds permissions from their role's preset (./presets.ts),
 * narrowed by overrides. An agent holds its sponsor's permissions
 * intersected with its own mandate per permission (never, propose, self).
 * Every door names the permission it needs (./doors.ts) and one pure
 * function answers allow, stage, sign or deny (./decide.ts).
 *
 * Named "permission" because "capability" already means two other things
 * here: paid entitlements (lib/entitlements) and module surfaces
 * (lib/modules/capabilities.ts).
 *
 * Pure data, no server imports: the menu, the settings sheet and every door
 * may read it.
 */

export const PERMISSIONS = [
  'bookkeeping.read',
  'bookkeeping.write',
  'invoicing',
  'payments.prepare',
  'payroll.read',
  'payroll.write',
  'tax.prepare',
  'periods',
  'agents.connect',
  'agents.autonomy',
  'members',
  'settings',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export interface PermissionDefinition {
  readonly id: Permission
  /** next-intl key of the short label, in the `permissions` namespace of src/messages/{sv,en}.json. */
  readonly labelKey: string
  /** next-intl key of the one-sentence description. */
  readonly descriptionKey: string
  /**
   * May an agent ever hold it? Never for the permissions that change who
   * may do what (members, agents.autonomy) or the company itself
   * (settings): a person decides those in the app.
   */
  readonly agentMayHold: boolean
}

/** The message key segment of a permission: next-intl reads dots as nesting, so 'bookkeeping.read' is 'bookkeeping_read'. */
export function permissionMessageKey(permission: Permission): string {
  return permission.replace('.', '_')
}

function define(id: Permission, agentMayHold: boolean): PermissionDefinition {
  const key = permissionMessageKey(id)
  return Object.freeze({
    id,
    labelKey: `permissions.${key}.label`,
    descriptionKey: `permissions.${key}.description`,
    agentMayHold,
  })
}

export const PERMISSION_CATALOG: Readonly<Record<Permission, PermissionDefinition>> = Object.freeze({
  'bookkeeping.read': define('bookkeeping.read', true),
  'bookkeeping.write': define('bookkeeping.write', true),
  invoicing: define('invoicing', true),
  'payments.prepare': define('payments.prepare', true),
  'payroll.read': define('payroll.read', true),
  'payroll.write': define('payroll.write', true),
  'tax.prepare': define('tax.prepare', true),
  periods: define('periods', true),
  'agents.connect': define('agents.connect', true),
  'agents.autonomy': define('agents.autonomy', false),
  members: define('members', false),
  settings: define('settings', false),
})

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}
