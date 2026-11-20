/**
 * The MCP half of the door catalog's guard (src/lib/permissions/doors.ts):
 * every tool in TOOL_SCOPE_MAP and UNSCOPED_TOOLS has exactly one door
 * (a generated tool by its operation, a hand-written one by its scope's
 * default or MCP_TOOL_DOORS), the override table names only live
 * hand-written tools whose default it changes, a tool stages exactly when
 * its door says it can, and a hand-written tool needs the same permission
 * as the pending types it stages, so approving asks for what calling asked.
 */
import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { TOOL_SCOPE_MAP, UNSCOPED_TOOLS } from '@/lib/auth/scope-catalog'
import { ALL_OPERATIONS, operationForPendingType } from '@/lib/operations/registry'
import { isOutsideDoor, pendingTypeDoor, scopeDoorSpec, type DoorRule } from '@/lib/permissions/doors'
import { MCP_TOOL_DOORS, mcpToolDoor } from '../permission-doors'
import { isStagingTool, tools } from '../server'

const generated = new Map(ALL_OPERATIONS.flatMap((op) => (op.mcp ? [[op.mcp.name, op] as const] : [])))
const loaded = new Map(tools.map((t) => [t.name, t]))
const catalogued = [...new Set([...Object.keys(TOOL_SCOPE_MAP), ...UNSCOPED_TOOLS, ...loaded.keys()])].sort()

/** A tool's door as the dispatcher would ask for it; undefined when the tool is neither loaded nor generated. */
function doorOf(name: string): DoorRule | null | undefined {
  const op = generated.get(name)
  const tool = loaded.get(name)
  if (op) {
    const stageable = tool ? isStagingTool(tool) : op.kind === 'write' && op.mcp?.stage !== undefined
    return mcpToolDoor({ name }, { stageable, operation: op })
  }
  if (!tool) return undefined
  return mcpToolDoor(tool, { stageable: isStagingTool(tool) })
}

/** The pending types each hand-written tool's block stages (type: '...'), read from the source as package-doors.test.ts does. */
function stagedTypesByTool(): Map<string, Set<string>> {
  const source = readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8')
  const starts = [...source.matchAll(/^\s{2,6}name: '(gnubok_[a-z0-9_]+)',/gm)].map((m) => ({ name: m[1], at: m.index! }))
  const notTypes = new Set(['object', 'string', 'array', 'number', 'boolean', 'integer', 'null', 'text', 'user', 'api_key', 'anonymous'])
  const out = new Map<string, Set<string>>()
  starts.forEach((tool, i) => {
    const block = source.slice(tool.at, starts[i + 1]?.at ?? source.length)
    const types = [...block.matchAll(/\btype:\s*'([a-z_]+)'/g)].map((m) => m[1]).filter((t) => !notTypes.has(t))
    out.set(tool.name, new Set(types))
  })
  return out
}

describe('MCP tool doors', () => {
  it('gives every catalogued tool a door', () => {
    const missing = catalogued.filter((name) => !doorOf(name))
    expect(
      missing,
      'A tool with no door: give its scope a default in SCOPE_DOORS or add it to MCP_TOOL_DOORS (permission-doors.ts).',
    ).toEqual([])
  })

  it('classifies each tool once: overrides name only live hand-written tools, and change their default', () => {
    const stale = Object.keys(MCP_TOOL_DOORS).filter((name) => generated.has(name) || !loaded.has(name))
    expect(stale, 'an override for a generated or missing tool: a generated tool is the door of its operation').toEqual([])
    const redundant = Object.entries(MCP_TOOL_DOORS)
      .filter(([name, entry]) => {
        const scope = TOOL_SCOPE_MAP[name]
        if (!scope || isOutsideDoor(entry)) return false
        const found = scopeDoorSpec(scope, loaded.get(name)?.annotations?.readOnlyHint === true)
        return found !== null && found.permission === entry.permission && found.effect === entry.effect && found.orPermission === entry.orPermission
      })
      .map(([name]) => name)
    expect(redundant).toEqual([])
  })

  it('puts every unscoped tool outside or on a permission it names', () => {
    for (const name of UNSCOPED_TOOLS) expect(Object.hasOwn(MCP_TOOL_DOORS, name), name).toBe(true)
  })

  it('stages exactly the tools that declare the staged envelope, and a generated tool as its operation', () => {
    for (const name of catalogued) {
      const door = doorOf(name)
      const tool = loaded.get(name)
      if (!door || isOutsideDoor(door) || !tool) continue
      expect(door.stageable, name).toBe(isStagingTool(tool))
      const op = generated.get(name)
      if (op) expect(door.stageable, `${name} vs ${op.id}`).toBe(op.kind === 'write' && op.mcp?.stage !== undefined)
    }
  })

  it('reads in every read-only tool', () => {
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint !== true) continue
      const door = doorOf(tool.name)
      if (door && !isOutsideDoor(door)) expect(door.effect, tool.name).toBe('read')
    }
  })

  it('asks the same permission to approve what a hand-written tool stages as to call it', () => {
    const staged = stagedTypesByTool()
    const mismatched: string[] = []
    for (const [name, types] of staged) {
      if (generated.has(name)) continue
      const door = doorOf(name)
      if (!door || isOutsideDoor(door)) continue
      for (const type of types) {
        const approval = pendingTypeDoor(type, operationForPendingType(type))
        if (!approval) mismatched.push(`${name} stages ${type}, which has no door`)
        else if (approval.permission !== door.permission) mismatched.push(`${name} (${door.permission}) stages ${type} (${approval.permission})`)
      }
    }
    expect(mismatched).toEqual([])
  })

  it('keeps the doors no company permission governs outside', () => {
    expect(doorOf('gnubok_search_tools')).toEqual({ outside: 'public' })
    expect(doorOf('gnubok_stage_tool')).toEqual({ outside: 'bridge' })
    expect(doorOf('gnubok_approve_pending_operation')).toEqual({ outside: 'approval' })
    expect(doorOf('gnubok_create_company')).toEqual({ outside: 'new-company' })
  })

  it('lets an agent at propose keep house: uploads and the bank feed change no books', () => {
    for (const name of ['gnubok_upload_document', 'gnubok_sync_bank', 'gnubok_remember_fact', 'gnubok_feedback']) {
      const door = doorOf(name)
      expect(door && !isOutsideDoor(door) ? door.effect : null, name).toBe('housekeeping')
    }
    const categorize = doorOf('gnubok_categorize_transaction')
    expect(categorize).toMatchObject({ permission: 'bookkeeping.write', effect: 'ledger', stageable: true })
  })
})
