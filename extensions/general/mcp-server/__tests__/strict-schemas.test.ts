/**
 * Guard against schema-strictness regression on MCP tool inputs.
 *
 * Every tool's `inputSchema` must declare `additionalProperties: false` so
 * agents receive a clear rejection on typos/hallucinated fields instead of a
 * silent ignore. This is item 8 of the agent-native API plan
 * (dev_docs/api_ai_architecture/PLAN.md).
 *
 * If this test fires on a newly authored tool, add the field to the tool's
 * top-level inputSchema. Don't relax the guard.
 */
import { describe, it, expect } from 'vitest'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { isTenantWriteScope } from '../company-routing'

describe('MCP tool inputSchema strictness', () => {
  it('every tool inputSchema has additionalProperties: false at the top level', () => {
    const missing = tools
      .filter((t) => {
        const schema = t.inputSchema as Record<string, unknown> | undefined
        return !schema || schema.additionalProperties !== false
      })
      .map((t) => t.name)
    expect(missing).toEqual([])
  })

  it('every tenant write tool has a scope that the central role guard can classify', () => {
    const allowedNonTenantWrites = new Set([
      'gnubok_audit_package',
      'gnubok_feedback',
    ])
    const missing = tools
      .filter(
        (tool) =>
          tool.annotations.readOnlyHint !== true &&
          !isTenantWriteScope(TOOL_SCOPE_MAP[tool.name]) &&
          !allowedNonTenantWrites.has(tool.name)
      )
      .map((tool) => tool.name)

    expect(missing).toEqual([])
  })

  it('every widget-bearing tool is read-only: Claude.ai drops write-annotated interactive tools', () => {
    // A tool with definition-level _meta.ui renders on every call. Claude.ai
    // accepts that only for read-only tools and silently DROPS a
    // write-annotated one from the connector (E2E #9, 2026-08-26: the SIE
    // drop card flapped into the Interactive list and vanished). Widget
    // tools mint links/lists only; actual writes go through separate
    // approval-gated tools the widget calls.
    const writers = tools
      .filter((t) => (t as { _meta?: { ui?: unknown } })._meta?.ui !== undefined)
      .filter((t) => t.annotations.readOnlyHint !== true)
      .map((t) => t.name)
    expect(writers).toEqual([])
  })
})
