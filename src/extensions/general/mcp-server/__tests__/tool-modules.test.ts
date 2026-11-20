/**
 * Every MCP tool belongs to exactly one module (tool-modules.ts), so
 * tools/list can hide a tool by its package the way the menu hides a page.
 * A new hand-written tool fails here until it is listed under its module; a
 * generated tool takes its operation's module.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { MODULE_IDS } from '@/lib/modules/manifest'
import { moduleForOperationId } from '@/lib/modules/resolve'
import { ALL_OPERATIONS } from '@/lib/operations/registry'
import { tools } from '../server'
import { HAND_WRITTEN_TOOL_MODULES, isClaimedTwice, moduleForTool } from '../tool-modules'

describe('tool modules', () => {
  it('place every tool in the registry in a module the manifest knows', () => {
    const known = new Set<string>(MODULE_IDS)
    const unplaced = tools.filter((t) => !known.has(moduleForTool(t.name) ?? '')).map((t) => t.name)
    expect(unplaced, 'list the tool under its module in tool-modules.ts').toEqual([])
  })

  it('list each hand-written tool once, and only tools that exist', () => {
    const names = Object.values(HAND_WRITTEN_TOOL_MODULES).flatMap((list) => [...(list ?? [])])
    const seen = new Set<string>()
    const twice = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)))
    expect(twice).toEqual([])
    const registry = new Set(tools.map((t) => t.name))
    // A dark operation's tool (collections without its env) is not in this
    // registry, but hand-written tools always are.
    expect(names.filter((n) => !registry.has(n))).toEqual([])
    expect(names.filter(isClaimedTwice)).toEqual([])
  })

  it('give a generated tool its operation module, dark operations included', () => {
    for (const op of ALL_OPERATIONS.filter((o) => o.mcp)) {
      expect(moduleForTool(op.mcp!.name), op.mcp!.name).toBe(moduleForOperationId(op.id))
    }
  })

  it('answers undefined for a name nothing claims', () => {
    expect(moduleForTool('gnubok_no_such_tool')).toBeUndefined()
  })
})
