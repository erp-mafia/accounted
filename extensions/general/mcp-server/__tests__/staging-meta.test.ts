/**
 * Guards the machine-readable staging contract surfaced via tools/list `_meta`.
 *
 * An agent must be able to tell: without reading description prose: whether a
 * write stages a pending_operation (and so needs a follow-up
 * gnubok_approve_pending_operation), and whether a read-only pre-flight exists.
 * That signal is `_meta.requires_approval` / `_meta.preflight`, derived from the
 * staged-operation output schema. These tests pin that derivation and the
 * companion prose convention so neither drifts.
 */
import { describe, it, expect } from 'vitest'
import { tools, deriveToolMeta } from '../server'

/** Structural proxy for STAGED_OPERATION_SCHEMA without importing the private const. */
function isStagingTool(t: { outputSchema?: Record<string, unknown> }): boolean {
  const schema = t.outputSchema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined
  return Boolean(schema?.properties?.staged) && Boolean(schema?.required?.includes('staged'))
}

describe('staging contract _meta', () => {
  it('requires_approval is set exactly for the tools that stage a pending_operation', () => {
    for (const t of tools) {
      const meta = deriveToolMeta(t)
      if (isStagingTool(t)) {
        expect(meta, `tool ${t.name} should expose staging _meta`).toBeDefined()
        expect(meta?.requires_approval, `tool ${t.name}`).toBe(true)
        expect(meta?.approve_tool, `tool ${t.name}`).toBe('gnubok_approve_pending_operation')
      } else {
        expect(meta, `tool ${t.name} must not claim to stage`).toBeUndefined()
      }
    }
  })

  it('every _meta.preflight points at a real, read-only tool', () => {
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const t of tools) {
      const preflight = deriveToolMeta(t)?.preflight as string | undefined
      if (!preflight) continue
      const target = byName.get(preflight)
      expect(target, `${t.name} preflight ${preflight} must exist`).toBeDefined()
      expect(target?.annotations.readOnlyHint, `preflight ${preflight} must be read-only`).toBe(true)
    }
  })

  it('every staging tool declares staging in its description (uniform prose signal)', () => {
    // The approval REFERENCE is carried machine-readably by _meta.approve_tool
    // (see the test above), so prose only needs to make the staging nature
    // unambiguous: every staged write says it stages (stage/stages/staged/staging).
    const violations = tools
      .filter(isStagingTool)
      .filter((t) => !/stag(e|ing)/i.test(t.description))
      .map((t) => t.name)
    expect(violations).toEqual([])
  })
})
