/**
 * Guard against schema-strictness regression on MCP tool inputs.
 *
 * Every tool's `inputSchema` must declare `additionalProperties: false` so
 * agents receive a clear rejection on typos/hallucinated fields instead of a
 * silent ignore.
 *
 * If this test fires on a newly authored tool, add the field to the tool's
 * top-level inputSchema. Don't relax the guard.
 */
import { describe, it, expect } from 'vitest'
import { tools, STAGE_BRIDGE_TARGETS } from '../server'
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
      // Stages INNER write tools per company: the tenant write scope that the
      // role guard classifies is the inner tool's, checked per company inside
      // the tool (assertMcpCompanyWriteAccess with the inner scope). The outer
      // scope only gates the scope resolution.
      'gnubok_stage_across_companies',
    ])
    // A different category from the two above, which genuinely write nothing
    // tenant-scoped. gnubok_stage_tool is never executed under its own name:
    // the dispatcher rewrites it to the inner tool BEFORE the scope lookup, so
    // the role guard classifies the INNER tool's scope. It therefore needs no
    // scope of its own, provided every tool it can carry has one, which the
    // next test requires with no allowlist to hide behind.
    const dispatcherRewrittenBridges = new Set(['gnubok_stage_tool'])
    const missing = tools
      .filter(
        (tool) =>
          tool.annotations.readOnlyHint !== true &&
          !isTenantWriteScope(TOOL_SCOPE_MAP[tool.name]) &&
          !allowedNonTenantWrites.has(tool.name) &&
          !dispatcherRewrittenBridges.has(tool.name)
      )
      .map((tool) => tool.name)

    expect(missing).toEqual([])
  })

  it('every tool gnubok_stage_tool can carry has a tenant write scope, with no exceptions', () => {
    // What makes the bridge exemption above safe. The viewer-role gate and the
    // scope check both key on the inner tool's scope; an unscoped carried tool
    // would be a write any key, and any viewer, could stage through the bridge.
    expect(STAGE_BRIDGE_TARGETS.length).toBeGreaterThan(0)
    const unscoped = STAGE_BRIDGE_TARGETS.filter(
      (tool) => !isTenantWriteScope(TOOL_SCOPE_MAP[tool.name]),
    ).map((tool) => tool.name)
    expect(unscoped).toEqual([])
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
