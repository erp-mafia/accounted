import { describe, expect, it } from 'vitest'
import { isStagingTool, tools, type McpToolAnnotations } from '../server'
import { toolCallableVia } from '../tool-reach'
import { annotationsForEffect, publicToolAnnotations } from '../tool-effects'

// @ts-expect-error every tool must declare its effect class
const missingEffect: McpToolAnnotations = { readOnlyHint: true }
void missingEffect

describe('MCP tool effects', () => {
  it('classifies every registered tool and derives the public hints', () => {
    for (const tool of tools) {
      expect(['read_only', 'additive', 'destructive'], tool.name).toContain(tool.annotations.effect)
      expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.annotations.effect === 'read_only')
      expect(tool.annotations.destructiveHint, tool.name).toBe(tool.annotations.effect === 'destructive')
    }
  })

  it('never lets a read-only tool reach a staging or direct-write path', () => {
    for (const tool of tools.filter((candidate) => candidate.annotations.effect === 'read_only')) {
      expect(isStagingTool(tool), tool.name).toBe(false)
      expect(tool.retryKey, tool.name).not.toBe(true)
      expect(toolCallableVia(tool, { listed: false, stages: true }), tool.name).toBe('call_tool')
    }
  })

  it('publishes only the MCP hints, never the effect class', () => {
    expect(publicToolAnnotations(annotationsForEffect('destructive', { idempotentHint: true }))).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })
  })
})
