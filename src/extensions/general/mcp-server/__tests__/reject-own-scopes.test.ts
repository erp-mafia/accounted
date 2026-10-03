/**
 * A key without pending_operations:approve may reject (withdraw) the agent
 * proposals it staged itself, through any scope a staging tool needs
 * (REJECT_OWN_SCOPES; founder decision 2026-10-03, follow-up to #3408). The
 * rule in lib/pending-operations/reject-authority.ts leans on "every staging
 * tool requires a REJECT_OWN_SCOPES member": a staging tool gated by any other
 * scope would let a key stage proposals it then cannot withdraw. This pins the
 * claim against the live registry, so a new staging tool under a new scope
 * fails here instead of drifting silently.
 */
import { describe, it, expect } from 'vitest'
import { REJECT_OWN_SCOPES, TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { isStagingTool, tools } from '../server'

describe('REJECT_OWN_SCOPES covers every staging tool', () => {
  const stagingTools = tools.filter((t) => isStagingTool(t))

  it('finds the staging tools (the guard is not a no-op)', () => {
    expect(stagingTools.length).toBeGreaterThan(20)
    expect(stagingTools.map((t) => t.name)).toContain('gnubok_propose_fact')
  })

  it('every staging tool is scoped, by a scope in REJECT_OWN_SCOPES', () => {
    for (const t of stagingTools) {
      const scope = TOOL_SCOPE_MAP[t.name]
      expect(scope, `${t.name} stages a proposal and needs a TOOL_SCOPE_MAP scope`).toBeDefined()
      expect(REJECT_OWN_SCOPES, `${t.name} stages under ${scope}`).toContain(scope)
    }
  })
})
