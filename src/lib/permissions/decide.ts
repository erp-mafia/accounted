/**
 * decide(): the one answer to "may this principal use this door?", the same
 * at every door (session routes, REST v1, MCP tools, the in-app assistant
 * and the approval commit seam).
 *
 *   allow  the door does what it does (commits, stages, reads)
 *   stage  the write is staged for a person to approve instead of committed
 *   sign   a person must approve it in Accounted (the approval link)
 *   deny   refused, with a reason code the agent can relay
 *
 * A person needs the door's permission. An agent needs it three times
 * over: the permission is one an agent may hold, its sponsor holds it, and
 * its mandate for it is not `never`. At `propose` an agent reads and keeps
 * house freely, stages ledger and register writes (or is refused where the
 * door cannot stage) and never approves on its own. At `self` it acts
 * directly, and approves a high-risk operation only where a person set
 * "high risk too" for that permission.
 *
 * Pure: no I/O, no clock. The callers resolve the principal and the door.
 */
import { PERMISSION_CATALOG, type Permission } from './catalog'
import type { DoorClass } from './doors'

export type MandateLevel = 'never' | 'propose' | 'self'
export type DecideOutcome = 'allow' | 'stage' | 'sign' | 'deny'
export type DecideRisk = 'low' | 'medium' | 'high'

export type PermissionSet = ReadonlySet<Permission> | readonly Permission[]

export type Principal =
  | { kind: 'person'; permissions: PermissionSet }
  | {
      kind: 'agent'
      /** The sponsor's own permissions in the company, live: an agent never exceeds its person. */
      sponsorPermissions: PermissionSet
      /** The mandate per permission; a permission left out is `never`. */
      levels: Partial<Record<Permission, MandateLevel>>
      /** "Gör själv, även hög risk": set by a person in the app, per permission. */
      highRiskToo: Partial<Record<Permission, boolean>>
    }

export interface DecideInput {
  principal: Principal
  door: DoorClass
  /** `call`: use the door. `approve`: commit a staged operation of the door's kind. */
  action: 'call' | 'approve'
  /** The staged operation's risk tier, for `approve`. Missing counts as high. */
  risk?: DecideRisk
  /** The agent approving is the one that staged the operation. */
  selfApproval?: boolean
  /** The operation type is approvable by a person in the web UI only (requiresWebApproval). */
  webOnly?: boolean
}

export type DecideReason =
  | 'PERSON_HAS_PERMISSION'
  | 'PERMISSION_MISSING'
  | 'AGENT_NEVER_HOLDS'
  | 'SPONSOR_LACKS_PERMISSION'
  | 'MANDATE_NEVER'
  | 'MANDATE_SELF'
  | 'READ'
  | 'HOUSEKEEPING'
  | 'PROPOSE_STAGES'
  | 'STAGE_REQUIRED'
  | 'SELF_APPROVAL'
  | 'PROPOSE_NEEDS_PERSON'
  | 'WEB_ONLY'
  | 'HIGH_RISK_NEEDS_PERSON'
  | 'HIGH_RISK_TOO'

export interface Decision {
  outcome: DecideOutcome
  reason: DecideReason
  /** The permission the answer was decided on (a door may accept two). */
  permission: Permission
}

const LEVEL_RANK: Readonly<Record<MandateLevel, number>> = { never: 0, propose: 1, self: 2 }

function holds(set: PermissionSet, permission: Permission): boolean {
  return 'has' in set ? set.has(permission) : set.includes(permission)
}

/** The door's permissions, its own first. */
function doorPermissions(door: DoorClass): Permission[] {
  return door.orPermission ? [door.permission, door.orPermission] : [door.permission]
}

export function decide(input: DecideInput): Decision {
  const { principal, door } = input
  const candidates = doorPermissions(door)
  const answer = (outcome: DecideOutcome, reason: DecideReason, permission = door.permission): Decision => ({
    outcome,
    reason,
    permission,
  })

  if (principal.kind === 'person') {
    const held = candidates.find((p) => holds(principal.permissions, p))
    return held ? answer('allow', 'PERSON_HAS_PERMISSION', held) : answer('deny', 'PERMISSION_MISSING')
  }

  const holdable = candidates.filter((p) => PERMISSION_CATALOG[p].agentMayHold)
  if (holdable.length === 0) return answer('deny', 'AGENT_NEVER_HOLDS')
  const sponsored = holdable.filter((p) => holds(principal.sponsorPermissions, p))
  if (sponsored.length === 0) return answer('deny', 'SPONSOR_LACKS_PERMISSION', holdable[0])

  // The best mandate among the permissions that open the door; the door's own wins a tie.
  let permission = sponsored[0]
  for (const p of sponsored) {
    if (LEVEL_RANK[principal.levels[p] ?? 'never'] > LEVEL_RANK[principal.levels[permission] ?? 'never']) permission = p
  }
  const level = principal.levels[permission] ?? 'never'
  if (level === 'never') return answer('deny', 'MANDATE_NEVER', permission)

  if (input.action === 'call') {
    if (level === 'self') return answer('allow', 'MANDATE_SELF', permission)
    if (door.effect === 'read') return answer('allow', 'READ', permission)
    if (door.effect === 'housekeeping') return answer('allow', 'HOUSEKEEPING', permission)
    return door.stageable
      ? answer('stage', 'PROPOSE_STAGES', permission)
      : answer('deny', 'STAGE_REQUIRED', permission)
  }

  // Approving a staged operation.
  if (input.webOnly) return answer('sign', 'WEB_ONLY', permission)
  if (level === 'propose') {
    return input.selfApproval
      ? answer('deny', 'SELF_APPROVAL', permission)
      : answer('sign', 'PROPOSE_NEEDS_PERSON', permission)
  }
  if ((input.risk ?? 'high') !== 'high') return answer('allow', 'MANDATE_SELF', permission)
  return principal.highRiskToo[permission] === true
    ? answer('allow', 'HIGH_RISK_TOO', permission)
    : answer('sign', 'HIGH_RISK_NEEDS_PERSON', permission)
}
