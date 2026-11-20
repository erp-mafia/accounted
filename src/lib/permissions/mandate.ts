/**
 * deriveMandate(): the mandate an existing API key acts at, read from what
 * the key is today, so that a key moved onto mandates keeps today's
 * behaviour.
 *
 * No mandate rows exist yet. The permission shadow (./shadow.ts) runs every
 * agent's decide() on this derivation, so the shadow log also tests it; the
 * wave that writes real mandate rows writes what this function answers.
 *
 *   - A write scope gives its door's permission (SCOPE_DOORS):
 *       manual or service-account key: `self` with "high risk too", since
 *         it commits directly today;
 *       OAuth key holding pending_operations:approve: `self`, since it may
 *         approve what it stages;
 *       OAuth key without it: `propose`, since it only stages.
 *   - A read scope gives its door's permission, and the door's second
 *     permission (invoicing reads), at `propose`: the lowest level that
 *     reads. Its writes stay with the write scopes.
 *   - A company the key was given read-only access to
 *     (api_key_companies.access = 'read') gets nothing from write scopes.
 *   - A permission no agent may hold (members, settings, agents.autonomy)
 *     is never given: decide() refuses it whatever the mandate says.
 *
 * Pure: no I/O.
 */
import { scopeKind } from '@/lib/auth/scope-catalog'
import { PERMISSION_CATALOG, type Permission } from './catalog'
import type { MandateLevel } from './decide'
import { isApiKeyScope, SCOPE_DOORS } from './doors'

/** How a key came to be: a person's manual key, an OAuth connector's key, or a service account's key. */
export type AgentKeyKind = 'manual' | 'oauth' | 'service_account'

export interface MandateKey {
  kind: AgentKeyKind
  /** The key's scopes; unknown values are ignored. */
  scopes: readonly string[]
  /** The key's access to the company in question; 'read' when the connection was given read-only access there. */
  companyAccess?: 'read' | 'write'
}

export interface DerivedMandate {
  levels: Partial<Record<Permission, MandateLevel>>
  highRiskToo: Partial<Record<Permission, boolean>>
}

const RANK: Readonly<Record<MandateLevel, number>> = { never: 0, propose: 1, self: 2 }

export function deriveMandate(key: MandateKey): DerivedMandate {
  const levels: Partial<Record<Permission, MandateLevel>> = {}
  const highRiskToo: Partial<Record<Permission, boolean>> = {}
  const canApprove = key.scopes.includes('pending_operations:approve')
  const writeLevel: MandateLevel = key.kind === 'oauth' ? (canApprove ? 'self' : 'propose') : 'self'
  const commitsDirectly = key.kind !== 'oauth'

  const give = (permission: Permission, level: MandateLevel) => {
    if (!PERMISSION_CATALOG[permission].agentMayHold) return
    if (RANK[level] > RANK[levels[permission] ?? 'never']) levels[permission] = level
  }

  for (const scope of key.scopes) {
    if (!isApiKeyScope(scope)) continue
    const door = SCOPE_DOORS[scope]
    if (!door) continue
    if (scopeKind(scope) === 'read') {
      give(door.permission, 'propose')
      if (door.orPermission) give(door.orPermission, 'propose')
      continue
    }
    if (key.companyAccess === 'read') continue
    give(door.permission, writeLevel)
    if (commitsDirectly && PERMISSION_CATALOG[door.permission].agentMayHold) highRiskToo[door.permission] = true
  }
  return { levels, highRiskToo }
}
