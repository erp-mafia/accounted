import { describe, expect, it } from 'vitest'
import { tools } from '../server'

/**
 * Identifier discipline (mcp_optimization_plan P1-2): agents grabbed the
 * wrong id when list rows exposed a bare `id` next to qualified ids like
 * `journal_entry_id` with no type distinction, got NOT_FOUND, and had to
 * re-derive. Every identifier in a tool OUTPUT schema must be fully
 * qualified (`transaction_id`, `journal_entry_id`, `fact_id`, …).
 *
 * Bare `id` survives only as a deprecated alias at the GRANDFATHERED paths
 * below, each shipping alongside its qualified sibling. This list may only
 * SHRINK (remove entries as the deprecated aliases are dropped) — a new bare
 * `id` anywhere fails this test; add the qualified name instead.
 */

const GRANDFATHERED_BARE_ID_PATHS = [
  'gnubok_forget_fact',
  'gnubok_get_agent_briefing.atoms[]',
  'gnubok_get_agent_briefing.company',
  'gnubok_get_agent_briefing.memory[]',
  'gnubok_list_dimension_values.dimension',
  'gnubok_list_dimension_values.values[]',
  'gnubok_list_dimensions.dimensions[]',
  'gnubok_list_dimensions.dimensions[].values[]',
  'gnubok_list_transactions_without_documents.transactions[]',
  'gnubok_list_uncategorized_transactions.transactions[]',
  'gnubok_remember_fact',
].sort()

type SchemaNode = {
  properties?: Record<string, unknown>
  items?: unknown
}

function collectBareIdPaths(): { path: string; siblingKeys: string[] }[] {
  const found: { path: string; siblingKeys: string[] }[] = []
  const walk = (schema: unknown, path: string) => {
    if (!schema || typeof schema !== 'object') return
    const s = schema as SchemaNode
    if (s.properties) {
      const keys = Object.keys(s.properties)
      if (keys.includes('id')) found.push({ path, siblingKeys: keys })
      for (const [key, val] of Object.entries(s.properties)) walk(val, `${path}.${key}`)
    }
    if (s.items) walk(s.items, `${path}[]`)
  }
  for (const t of tools) walk(t.outputSchema, t.name)
  return found
}

describe('qualified identifiers in tool output schemas', () => {
  it('no tool exposes a bare `id` outside the shrinking grandfathered list', () => {
    const actual = collectBareIdPaths()
      .map((f) => f.path)
      .sort()
    const newOffenders = actual.filter((p) => !GRANDFATHERED_BARE_ID_PATHS.includes(p))
    expect(
      newOffenders,
      `New bare \`id\` in an output schema — use a qualified name (transaction_id, journal_entry_id, …) instead:\n${newOffenders.join('\n')}`,
    ).toEqual([])
  })

  it('every remaining bare `id` ships alongside its qualified sibling', () => {
    const missingSibling = collectBareIdPaths().filter(
      (f) => !f.siblingKeys.some((k) => k !== 'id' && k.endsWith('_id')),
    )
    expect(
      missingSibling.map((f) => f.path),
      'bare `id` without a qualified *_id sibling — agents cannot migrate off the deprecated alias',
    ).toEqual([])
  })

  it('the grandfathered list only shrinks (entries removed when aliases are dropped)', () => {
    const actual = collectBareIdPaths()
      .map((f) => f.path)
      .sort()
    const stale = GRANDFATHERED_BARE_ID_PATHS.filter((p) => !actual.includes(p))
    expect(
      stale,
      `Grandfathered paths no longer exist — remove them from GRANDFATHERED_BARE_ID_PATHS:\n${stale.join('\n')}`,
    ).toEqual([])
  })
})
