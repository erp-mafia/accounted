import { describe, it, expect } from 'vitest'
import { buildMigrationSql } from '../generate-skill-bodies'
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
    frontmatter_version: 1,
    schema_version: 1,
    ...overrides,
  }
}

describe('buildMigrationSql', () => {
  it('dollar-quotes bodies with backticks, $$, quotes, and the default tag — round-trips intact', () => {
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

  it('emits parent_atom_id — NULL for top-level skills, a quoted id for reference children', () => {
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

  it('omits is_active / mcp_exposed from the upsert so manual flips survive re-seed', () => {
    const sql = buildMigrationSql([atom({})], { 'horizontal/test': 1 })
    // The INSERT column list takes column defaults for these on first insert...
    const columnList = sql.match(/INSERT INTO public\.agent_atom_registry\s*\n\s*\(([^)]*)\)/)?.[1] ?? ''
    expect(columnList).not.toContain('mcp_exposed')
    expect(columnList).not.toContain('is_active')
    // ...and the DO UPDATE SET must not overwrite them on conflict.
    const updateClause = sql.slice(sql.indexOf('DO UPDATE SET'))
    expect(updateClause).not.toContain('mcp_exposed')
    expect(updateClause).not.toContain('is_active')
  })
})
