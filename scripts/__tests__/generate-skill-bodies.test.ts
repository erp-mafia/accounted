import { describe, it, expect } from 'vitest'
import { atomHash, buildMigrationSql, planSeed, type Manifest } from '../generate-skill-bodies'
import type { DiscoveredAtom } from '../lib/atom-discovery'

function atom(overrides: Partial<DiscoveredAtom>): DiscoveredAtom {
  return {
    id: 'horizontal/test',
    tier: 'horizontal',
    slug: 'test',
    title: 'Test',
    description: 'desc',
    sni_prefixes: [],
    trigger_signals: {},
    estimated_tokens: 1,
    body_path: '.claude/skills/test/SKILL.md',
    body: 'body',
    parent_atom_id: null,
    audience: 'agent',
    frontmatter_version: 1,
    schema_version: 1,
    ...overrides,
  }
}

describe('buildMigrationSql', () => {
  it('dollar-quotes bodies with backticks, $$, quotes, and the default tag: round-trips intact', () => {
    const tricky = 'Body with `code`, $$dollars$$, \'single\' and "double" quotes, and a $gb$ tag.'
    const sql = buildMigrationSql([atom({ body: tricky, description: tricky })], { 'horizontal/test': 1 })

    // The content survives verbatim inside the SQL...
    expect(sql).toContain(tricky)
    // ...because the tag escalated past the embedded $gb$.
    expect(sql).toMatch(/\$gb0\$/)
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE')
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('emits a text[] literal for sni_prefixes and jsonb for trigger_signals', () => {
    const sql = buildMigrationSql(
      [atom({ sni_prefixes: ['62.01', '62.02'], trigger_signals: { foo: 'bar' } })],
      { 'horizontal/test': 1 },
    )
    expect(sql).toContain("ARRAY['62.01', '62.02']::text[]")
    expect(sql).toContain('::jsonb')
    expect(sql).toContain('{"foo":"bar"}')
  })

  it('escapes single quotes in short text fields (title/id)', () => {
    const sql = buildMigrationSql([atom({ title: "O'Brien & Co" })], { 'horizontal/test': 1 })
    expect(sql).toContain("'O''Brien & Co'")
  })

  it('emits parent_atom_id: NULL for top-level skills, a quoted id for reference children', () => {
    const sql = buildMigrationSql(
      [
        atom({ id: 'horizontal/swedish-vat', parent_atom_id: null }),
        atom({
          id: 'horizontal/swedish-vat/vat-compliance-reference',
          parent_atom_id: 'horizontal/swedish-vat',
        }),
      ],
      {
        'horizontal/swedish-vat': 1,
        'horizontal/swedish-vat/vat-compliance-reference': 1,
      },
    )
    // Column wired into both the INSERT list and the conflict update.
    expect(sql).toContain(', body, parent_atom_id, version,')
    expect(sql).toContain('parent_atom_id = EXCLUDED.parent_atom_id')
    // Parent row carries a literal NULL; child row carries the parent id.
    expect(sql).toMatch(/\$gb\$body\$gb\$,\n {4}NULL,/)
    expect(sql).toContain("'horizontal/swedish-vat',\n    1,")
  })

  it('preserves the emergency kill switch and non-community curation on re-seed', () => {
    const sql = buildMigrationSql([atom({})], { 'horizontal/test': 1 })
    // The INSERT column list takes column defaults for these on first insert...
    const columnList = sql.match(/INSERT INTO public\.agent_atom_registry\s*\n\s*\(([^)]*)\)/)?.[1] ?? ''
    expect(columnList).toContain('mcp_exposed')
    expect(columnList).not.toContain('is_active')
    // ...and the DO UPDATE SET must not overwrite them on conflict.
    const updateClause = sql.slice(sql.indexOf('DO UPDATE SET'))
    expect(updateClause).toContain("CASE WHEN EXCLUDED.tier = 'community' THEN EXCLUDED.mcp_exposed ELSE public.agent_atom_registry.mcp_exposed END")
    expect(updateClause).not.toContain('is_active')
  })

  it('switches withdrawn rows off by id, never deleting them', () => {
    const sql = buildMigrationSql([atom({})], { 'horizontal/test': 1 }, ['community/withdrawn', 'horizontal/test/wire-format'])
    expect(sql).toContain("SET is_active = false, mcp_exposed = false WHERE id IN ('community/withdrawn', 'horizontal/test/wire-format')")
    expect(sql).not.toContain('DELETE FROM')
    const insert = sql.slice(0, sql.indexOf('ON CONFLICT'))
    expect(insert).not.toContain('horizontal/test/wire-format')
  })

  it('emits no INSERT when a seed only withdraws', () => {
    const sql = buildMigrationSql([], {}, ['community/withdrawn'])
    expect(sql).not.toContain('INSERT INTO')
    expect(sql).toContain("WHERE id IN ('community/withdrawn')")
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'")
  })
})

describe('atomHash', () => {
  it('changes with every column the seed writes, so no edit can ship silently', () => {
    const base = atom({ sni_prefixes: ['62'], trigger_signals: { a: 1 }, mcp_exposed: true, reviewed_at: '2026-09-17' })
    const edits: Partial<DiscoveredAtom>[] = [
      { tier: 'vertical' },
      { title: 'Other title' },
      { description: 'other desc' },
      { sni_prefixes: ['63'] },
      { trigger_signals: { a: 2 } },
      { estimated_tokens: 2 },
      { body_path: '.claude/skills/other/SKILL.md' },
      { body: 'other body' },
      { parent_atom_id: 'horizontal/parent' },
      { schema_version: 2 },
      { mcp_exposed: false },
      { reviewed_at: '2026-10-01' },
    ]
    for (const edit of edits) {
      expect(atomHash({ ...base, ...edit }), JSON.stringify(edit)).not.toBe(atomHash(base))
    }
  })

  it('ignores fields the seed never writes', () => {
    const base = atom({})
    expect(atomHash({ ...base, slug: 'other', frontmatter_version: 9 })).toBe(atomHash(base))
  })
})

describe('planSeed', () => {
  const kept = atom({ id: 'horizontal/kept', body: 'kept' })
  const edited = atom({ id: 'horizontal/edited', body: 'edited v2' })
  const retitled = atom({ id: 'vertical/retitled', tier: 'vertical', title: 'New title' })
  const fresh = atom({ id: 'modifier/fresh', tier: 'modifier' })
  const previous: Manifest = {
    'horizontal/kept': { hash: atomHash(kept), version: 3 },
    'horizontal/edited': { hash: atomHash(atom({ id: 'horizontal/edited', body: 'edited v1' })), version: 4 },
    'vertical/retitled': { hash: atomHash(atom({ id: 'vertical/retitled', tier: 'vertical', title: 'Old title' })), version: 2 },
    'horizontal/deleted': { hash: 'x', version: 1 },
    'community/withdrawn': { hash: 'x', version: 5 },
    'horizontal/edited/wire-format': { hash: 'x', version: 2 },
  }
  const plan = planSeed([edited, fresh, kept, retitled], ['horizontal/edited/wire-format', 'horizontal/kept/never-shipped'], previous)

  it('seeds only added and changed atoms, metadata-only edits included', () => {
    expect(plan.added).toEqual(['modifier/fresh'])
    expect(plan.changed).toEqual(['horizontal/edited', 'vertical/retitled'])
    expect(plan.upserts.map((a) => a.id)).toEqual(['horizontal/edited', 'modifier/fresh', 'vertical/retitled'])
    const sql = buildMigrationSql(plan.upserts, plan.versions, plan.withdrawn)
    expect(sql).not.toContain("'horizontal/kept'")
  })

  it('starts new atoms at 1, bumps changed ones by one and keeps unchanged versions', () => {
    expect(plan.versions).toEqual({ 'horizontal/edited': 5, 'modifier/fresh': 1, 'horizontal/kept': 3, 'vertical/retitled': 3 })
  })

  it('withdraws removed community skills and references now developer-only, once', () => {
    expect(plan.removed).toEqual(['community/withdrawn', 'horizontal/deleted', 'horizontal/edited/wire-format'])
    // A deleted non-community file keeps its row, as the full seed always did; a
    // developer-only file no seed ever shipped has no row to switch off.
    expect(plan.withdrawn).toEqual(['community/withdrawn', 'horizontal/edited/wire-format'])
  })

  it('writes a manifest of exactly the current atoms, so the next run sees no drift', () => {
    expect(Object.keys(plan.manifest).sort()).toEqual(['horizontal/edited', 'horizontal/kept', 'modifier/fresh', 'vertical/retitled'])
    expect(plan.manifest['horizontal/kept']).toEqual(previous['horizontal/kept'])
    const next = planSeed([edited, fresh, kept, retitled], ['horizontal/edited/wire-format'], plan.manifest)
    expect([next.added, next.changed, next.removed, next.withdrawn, next.upserts]).toEqual([[], [], [], [], []])
    expect(next.versions).toEqual(plan.versions)
  })

  it('seeds everything from an empty manifest: the first seed is a full one', () => {
    const first = planSeed([kept, edited], [], {})
    expect(first.upserts.map((a) => a.id)).toEqual(['horizontal/kept', 'horizontal/edited'])
    expect(Object.values(first.versions)).toEqual([1, 1])
  })
})
