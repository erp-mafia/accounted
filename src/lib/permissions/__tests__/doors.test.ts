/**
 * The door catalog's guard: every session write route, operation, v1
 * endpoint and pending type is classified exactly once, and every entry of
 * the tables names a live door it changes the class of. The MCP server's
 * tools are checked in src/extensions/general/mcp-server/__tests__/
 * permission-doors.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { listEndpoints } from '@/lib/api/v1/registry'
import '@/lib/api/v1/load-routes'
import { ALL_OPERATIONS, operationForPendingType } from '@/lib/operations/registry'
import { SESSION_ROUTE_PARITY } from '@/lib/operations/session-route-parity'
import { PENDING_OPERATION_TYPES, OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { isPermission } from '../catalog'
import {
  isApiKeyScope,
  isOutsideDoor,
  OPERATION_DOORS,
  operationDoor,
  PENDING_APPROVAL_DOORS,
  PENDING_TYPE_DOORS,
  pendingTypeDoor,
  scopeDoorSpec,
  SCOPE_DOORS,
  SESSION_DOOR_RULES,
  sessionRequestDoor,
  sessionRouteDoor,
  sessionRuleForKey,
  V1_DOORS,
  v1EndpointDoor,
  type DoorRule,
  type DoorSpec,
} from '../doors'

/** Dashboard write routes that are user doors (machine endpoints answer to a secret or a signature, not a role). */
const sessionRoutes = Object.entries(SESSION_ROUTE_PARITY)
  .filter(([, entry]) => entry.status !== 'machine')
  .map(([key]) => key)

const operationsById = new Map(ALL_OPERATIONS.map((op) => [op.id, op]))

/** A concrete request path for a route key: every :param becomes a sample value. */
function concrete(key: string): { method: string; pathname: string } {
  const [method, pattern] = key.split(' ')
  return { method, pathname: pattern.replace(/:[A-Za-z_]+\*?/g, 'sample-0001') }
}

function sameSpec(a: DoorSpec, b: DoorSpec | null): boolean {
  return b !== null && a.permission === b.permission && a.effect === b.effect && a.orPermission === b.orPermission
}

function wellFormed(rule: DoorRule): boolean {
  if (isOutsideDoor(rule)) return true
  return isPermission(rule.permission) && (rule.orPermission === undefined || isPermission(rule.orPermission))
}

describe('session routes', () => {
  it('writes every rule as a path under /api, with an optional write method', () => {
    const malformed = Object.keys(SESSION_DOOR_RULES).filter((key) => !/^((POST|PUT|PATCH|DELETE) )?\/api(\/[^\s/]+)+$/.test(key))
    expect(malformed).toEqual([])
  })

  it('classifies every dashboard write route', () => {
    const missing = sessionRoutes.filter((key) => sessionRouteDoor(key) === null)
    expect(
      missing,
      'A dashboard write route with no door: add a rule to SESSION_DOOR_RULES (src/lib/permissions/doors.ts).',
    ).toEqual([])
    for (const key of sessionRoutes) expect(wellFormed(sessionRouteDoor(key)!), key).toBe(true)
  })

  it('has no stale rule: each one classifies at least one live route', () => {
    const used = new Set(sessionRoutes.map((key) => sessionRuleForKey(key)))
    const stale = Object.keys(SESSION_DOOR_RULES).filter((rule) => !used.has(rule))
    expect(stale, 'SESSION_DOOR_RULES entries that classify no route: delete them.').toEqual([])
  })

  it('classifies a concrete request as its route key', () => {
    for (const key of sessionRoutes) {
      const { method, pathname } = concrete(key)
      expect(sessionRequestDoor(method, pathname), key).toEqual(sessionRouteDoor(key))
    }
  })

  it('puts the approval doors outside, decided per staged operation', () => {
    for (const key of ['POST /api/pending-operations/:id/commit', 'POST /api/pending-operations/bulk-commit']) {
      expect(sessionRouteDoor(key)).toEqual({ outside: 'approval' })
    }
  })

  it('stages where a member asks and an owner or admin decides, and nowhere else', () => {
    const staging = sessionRoutes.filter((key) => {
      const door = sessionRouteDoor(key)
      return door !== null && !isOutsideDoor(door) && door.stageable
    })
    expect(staging.sort()).toEqual(['POST /api/grants/:id/revoke', 'POST /api/packages/:packageId'])
  })
})

describe('operations', () => {
  it('classifies every operation', () => {
    const missing = ALL_OPERATIONS.filter((op) => operationDoor(op) === null).map((op) => op.id)
    expect(missing).toEqual([])
    for (const op of ALL_OPERATIONS) expect(wellFormed(operationDoor(op)!), op.id).toBe(true)
  })

  it('reads in every read operation, and stages exactly the writes that stage over MCP', () => {
    for (const op of ALL_OPERATIONS) {
      const door = operationDoor(op)!
      if (op.kind === 'read') expect(door.effect, op.id).toBe('read')
      expect(door.stageable, op.id).toBe(op.kind === 'write' && op.mcp?.stage !== undefined)
    }
  })

  it('has no stale or redundant OPERATION_DOORS entry', () => {
    const stale = Object.keys(OPERATION_DOORS).filter((id) => !operationsById.has(id))
    expect(stale).toEqual([])
    const redundant = Object.entries(OPERATION_DOORS)
      .filter(([id, entry]) => {
        const op = operationsById.get(id)
        return op && sameSpec(entry, scopeDoorSpec(op.scope, op.kind === 'read'))
      })
      .map(([id]) => id)
    expect(redundant, 'an entry equal to its scope default: delete it').toEqual([])
  })
})

describe('v1 endpoints', () => {
  it('classifies every v1 endpoint, an operation door by its operation', () => {
    const missing: string[] = []
    for (const endpoint of listEndpoints()) {
      const door = v1EndpointDoor(endpoint, operationsById.get(endpoint.operation))
      if (!door) missing.push(`${endpoint.method} ${endpoint.path}`)
      else expect(wellFormed(door), endpoint.path).toBe(true)
    }
    expect(missing).toEqual([])
  })

  it('has no stale or redundant V1_DOORS entry: each names a hand-written endpoint whose default it changes', () => {
    const handWritten = new Map(
      listEndpoints()
        .filter((e) => !operationsById.has(e.operation))
        .map((e) => [`${e.method} ${e.path}`, e]),
    )
    const stale = Object.keys(V1_DOORS).filter((key) => !handWritten.has(key))
    expect(stale, 'V1_DOORS names an operation door or a missing endpoint').toEqual([])
    const redundant = Object.entries(V1_DOORS)
      .filter(([key, entry]) => {
        const e = handWritten.get(key)
        if (!e || isOutsideDoor(entry) || !isApiKeyScope(e.scope)) return false
        return sameSpec(entry, scopeDoorSpec(e.scope, e.method === 'GET'))
      })
      .map(([key]) => key)
    expect(redundant).toEqual([])
  })

  it('stages a hand-written endpoint only where it supports stage mode', () => {
    for (const endpoint of listEndpoints()) {
      if (operationsById.has(endpoint.operation)) continue
      const door = v1EndpointDoor(endpoint)
      if (door && !isOutsideDoor(door)) expect(door.stageable, endpoint.path).toBe(endpoint.stageSupported === true)
    }
  })
})

describe('pending operation types', () => {
  const staged = new Set(ALL_OPERATIONS.flatMap((op) => (op.mcp?.stage ? [op.mcp.stage.pendingType as string] : [])))

  it('classifies every pending type exactly once: by its operation, or in PENDING_TYPE_DOORS', () => {
    const missing: string[] = []
    const twice: string[] = []
    for (const type of PENDING_OPERATION_TYPES) {
      const byOperation = staged.has(type)
      const byTable = Object.hasOwn(PENDING_TYPE_DOORS, type)
      if (byOperation && byTable) twice.push(type)
      if (!byOperation && !byTable) missing.push(type)
      const door = pendingTypeDoor(type, operationForPendingType(type))
      expect(door?.stageable, type).toBe(true)
    }
    expect(missing, 'a pending type no operation stages: add it to PENDING_TYPE_DOORS').toEqual([])
    expect(twice, 'a pending type an operation stages: delete it from PENDING_TYPE_DOORS').toEqual([])
  })

  it('has no stale entry', () => {
    const live = new Set<string>(PENDING_OPERATION_TYPES)
    expect(Object.keys(PENDING_TYPE_DOORS).filter((t) => !live.has(t))).toEqual([])
    expect(Object.keys(PENDING_APPROVAL_DOORS).filter((t) => !staged.has(t)), 'PENDING_APPROVAL_DOORS is for operation-staged types').toEqual([])
  })

  it('has a risk tier for every classified type, so the seam can ask decide() about high risk', () => {
    for (const type of PENDING_OPERATION_TYPES) expect(OPERATION_RISK_TIERS[type], type).toBeDefined()
  })

  it('needs a person with settings to switch a package, whoever asked for it', () => {
    expect(pendingTypeDoor('enable_package', operationForPendingType('enable_package'))?.permission).toBe('settings')
    expect(pendingTypeDoor('create_grant')?.permission).toBe('agents.autonomy')
  })
})

describe('scope defaults', () => {
  it('names a default for every scope but approving', () => {
    const none = Object.entries(SCOPE_DOORS)
      .filter(([, door]) => door === null)
      .map(([scope]) => scope)
    expect(none).toEqual(['pending_operations:approve'])
  })
})

describe('the Bolaget doors', () => {
  const doorOf = (id: string) => {
    const op = operationsById.get(id)
    expect(op, id).toBeDefined()
    return operationDoor(op!)!
  }

  it('keeps the ownership and signatory registers for an owner or admin on every door', () => {
    for (const key of [
      'POST /api/bolaget/share-register/events',
      'POST /api/bolaget/share-classes',
      'PATCH /api/bolaget/share-classes/:id',
      'POST /api/bolaget/roles',
      'POST /api/bolaget/roles/:id/end',
      'POST /api/bolaget/signatory-rules',
      'POST /api/bolaget/beneficial-owners/assessments',
      'PATCH /api/bolaget/people/:partyId',
      'PATCH /api/bolaget/settings',
    ]) {
      expect(sessionRouteDoor(key), key).toMatchObject({ permission: 'settings', effect: 'record' })
    }
    for (const id of [
      'share-register.events.create',
      'share-classes.create',
      'share-classes.update',
      'company-roles.create',
      'company-roles.end',
      'signatory-rules.set',
      'beneficial-owners.confirm',
    ]) {
      expect(doorOf(id), id).toMatchObject({ permission: 'settings', effect: 'record' })
    }
  })

  it('lets any writer keep the other Bolaget records on every door, and posts only through the ledger doors', () => {
    for (const id of [
      'corporate-meetings.create',
      'corporate-meetings.update',
      'corporate-meetings.decisions.record',
      'corporate-meetings.hold',
      'dividends.create',
      'capital-changes.create',
      'k10-inputs.set',
      'owner-loans.create',
      'owner-loans.update',
      'owner-loans.set-interest',
      'agreements.create',
      'agreements.update',
      'agreements.end',
      'securities.create',
      'securities.update',
      'group-links.create',
      'group-links.update',
    ]) {
      expect(doorOf(id), id).toMatchObject({ permission: 'bookkeeping.write', effect: 'record' })
    }
    for (const id of ['dividends.book', 'dividends.pay', 'shareholder-contributions.create', 'capital-changes.book']) {
      expect(doorOf(id), id).toMatchObject({ permission: 'bookkeeping.write', effect: 'ledger' })
    }
    expect(sessionRouteDoor('POST /api/bolaget/meetings')).toMatchObject({ permission: 'bookkeeping.write', effect: 'record' })
    expect(sessionRouteDoor('POST /api/bolaget/capital/dividends')).toMatchObject({ permission: 'bookkeeping.write', effect: 'record' })
    expect(sessionRouteDoor('POST /api/bolaget/capital/dividends/:id/book')).toMatchObject({ permission: 'bookkeeping.write', effect: 'ledger' })
    expect(sessionRouteDoor('PUT /api/bolaget/owner-tax/k10/:year/owners/:partyId')).toMatchObject({ permission: 'bookkeeping.write', effect: 'record' })
    expect(sessionRouteDoor('POST /api/commitments/agreements')).toMatchObject({ permission: 'bookkeeping.write', effect: 'record' })
  })
})
