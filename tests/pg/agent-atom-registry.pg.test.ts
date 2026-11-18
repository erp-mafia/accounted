import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { buildMigrationSql, planSeed, type Manifest } from '@/scripts/generate-skill-bodies'
import { discoverAtoms, type DiscoveredAtom } from '@/scripts/lib/atom-discovery'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient, withUserContext } from '@/tests/pg/setup'

describe('agent_atom_registry.pg: seed + RLS', () => {
  it('seed migration populated active atoms with non-null bodies and no swarm-* ids', async () => {
    const { userId } = await seedCompany()
    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ id: string; body: string | null; mcp_exposed: boolean }>(
        `SELECT id, body, mcp_exposed FROM public.agent_atom_registry WHERE is_active`,
      )
      return res.rows
    })

    // The generated seed migration (…_seed_agent_atom_bodies.sql) runs during replay.
    expect(rows.length).toBeGreaterThan(0)
    // Every active atom has a real body inlined: the production read path depends
    // on this (no disk fallback in production).
    for (const r of rows) {
      expect(r.body, `atom ${r.id} body should be non-empty`).toBeTruthy()
      expect(r.mcp_exposed).toBe(true)
    }
    // swarm-* audit skills must never become atoms; a curated horizontal must be present.
    expect(rows.some((r) => r.id.includes('swarm'))).toBe(false)
    expect(rows.some((r) => r.id === 'horizontal/swedish-vat')).toBe(true)
  })

  it('seeds reference children whose parent_atom_id points at a real top-level skill', async () => {
    const { userId } = await seedCompany()
    const { children, orphans, vatRef } = await withUserContext(userId, async (client) => {
      const childRes = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.agent_atom_registry WHERE parent_atom_id IS NOT NULL`,
      )
      // FK already guarantees this, but assert there are no dangling links anyway.
      const orphanRes = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM public.agent_atom_registry c
          WHERE c.parent_atom_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM public.agent_atom_registry p WHERE p.id = c.parent_atom_id
            )`,
      )
      const vatRefRes = await client.query<{ id: string; body: string | null; parent_atom_id: string }>(
        `SELECT id, body, parent_atom_id FROM public.agent_atom_registry
          WHERE id = 'horizontal/swedish-vat/vat-compliance-reference'`,
      )
      return { children: childRes.rows[0]!.n, orphans: orphanRes.rows[0]!.n, vatRef: vatRefRes.rows[0] }
    })

    expect(children).toBeGreaterThan(0)
    expect(orphans).toBe(0)
    expect(vatRef?.parent_atom_id).toBe('horizontal/swedish-vat')
    expect(vatRef?.body).toBeTruthy()
  })

  it('catalog filter (parent_atom_id IS NULL) hides references but the parent footer exposes them', async () => {
    const { userId } = await seedCompany()
    const { listed, vatBody } = await withUserContext(userId, async (client) => {
      // The query every catalog uses: top-level skills only.
      const listedRes = await client.query<{ id: string }>(
        `SELECT id FROM public.agent_atom_registry
          WHERE is_active AND parent_atom_id IS NULL`,
      )
      const vatRes = await client.query<{ body: string }>(
        `SELECT body FROM public.agent_atom_registry WHERE id = 'horizontal/swedish-vat'`,
      )
      return { listed: listedRes.rows.map((r) => r.id), vatBody: vatRes.rows[0]?.body ?? '' }
    })

    // No reference id (three-segment, "<tier>/<slug>/<ref>") survives the filter.
    expect(listed.some((id) => id.split('/').length === 3)).toBe(false)
    expect(listed).toContain('horizontal/swedish-vat')
    // …yet the loadable id is reachable from the parent body once loaded.
    expect(vatBody).toContain('gnubok_load_skill("horizontal/swedish-vat/vat-compliance-reference")')
  })

  it('authenticated users can read the catalog but not write it', async () => {
    const { userId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const sel = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.agent_atom_registry`,
      )
      expect(sel.rows[0]!.n).toBeGreaterThan(0)

      // No INSERT policy for authenticated: the catalog ships via service-role
      // migrations only.
      await expect(
        client.query(
          `INSERT INTO public.agent_atom_registry (id, tier, title, description, body_path)
           VALUES ('horizontal/hacker', 'horizontal', 'x', 'x', 'x')`,
        ),
      ).rejects.toThrow()
    })
  })
})

describe('agent_atom_registry.pg: incremental seeds', () => {
  it('replaying every migration leaves each agent atom row exactly as its files and the manifest say', async () => {
    const root = process.cwd()
    const discovered = await discoverAtoms(root)
    const atoms = discovered.filter((a) => a.audience === 'agent')
    const developerOnly = discovered.filter((a) => a.audience === 'developer').map((a) => a.id)
    const manifest = JSON.parse(readFileSync(join(root, 'scripts/.skill-body-manifest.json'), 'utf8')) as Manifest

    const client = await getClient()
    try {
      const { rows } = await client.query<Record<string, unknown> & { id: string }>(
        `SELECT id, tier, title, description, sni_prefixes, trigger_signals, estimated_tokens, body_path,
                body, parent_atom_id, version, schema_version, is_active, mcp_exposed
           FROM public.agent_atom_registry`,
      )
      const byId = new Map(rows.map((r) => [r.id, r]))
      // Seeds carry only what changed, so a manifest committed without its
      // migration would leave a stale row forever: this is where it shows.
      const drift: string[] = []
      for (const a of atoms) {
        const row = byId.get(a.id)
        if (!row) {
          drift.push(`${a.id}: no row`)
          continue
        }
        const expected: Record<string, unknown> = {
          tier: a.tier,
          title: a.title,
          description: a.description,
          sni_prefixes: a.sni_prefixes,
          trigger_signals: JSON.parse(JSON.stringify(a.trigger_signals ?? {})),
          estimated_tokens: a.estimated_tokens,
          body_path: a.body_path,
          body: a.body,
          parent_atom_id: a.parent_atom_id,
          version: manifest[a.id]?.version,
          schema_version: a.schema_version,
        }
        for (const [column, value] of Object.entries(expected)) {
          if (!isDeepStrictEqual(row[column], value)) drift.push(`${a.id}: ${column}`)
        }
      }
      for (const id of developerOnly) {
        const row = byId.get(id)
        if (row && (row.is_active || row.mcp_exposed)) drift.push(`${id}: developer-only yet active`)
      }
      expect(drift).toEqual([])
    } finally {
      client.release()
    }
  })

  it('an incremental seed leaves the registry exactly as a full seed would', async () => {
    const fixture = (overrides: Partial<DiscoveredAtom> & Pick<DiscoveredAtom, 'id' | 'tier'>): DiscoveredAtom => ({
      slug: 'zz-seed',
      title: 'Seed test',
      description: 'desc',
      sni_prefixes: [],
      trigger_signals: {},
      estimated_tokens: 1,
      body_path: '.claude/skills/zz-seed/SKILL.md',
      body: 'body',
      parent_atom_id: null,
      audience: 'agent',
      frontmatter_version: 1,
      schema_version: 1,
      ...overrides,
    })
    const parent = fixture({ id: 'vertical/zz-seed-parent', tier: 'vertical', body: 'parent v1' })
    const ref = fixture({ id: 'vertical/zz-seed-parent/ref', tier: 'vertical', parent_atom_id: parent.id, title: 'Ref v1' })
    const wire = fixture({ id: 'vertical/zz-seed-parent/wire', tier: 'vertical', parent_atom_id: parent.id })
    const kept = fixture({ id: 'modifier/zz-seed-kept', tier: 'modifier', sni_prefixes: ['62'], trigger_signals: { b: 1, a: [2] } })
    const deleted = fixture({ id: 'modifier/zz-seed-deleted', tier: 'modifier' })
    const community = fixture({ id: 'community/zz-seed-gone', tier: 'community', mcp_exposed: true, reviewed_at: '2026-09-17' })
    const before = [community, kept, deleted, parent, ref, wire]
    // Since then: parent body edited, ref retitled, wire marked developer-only,
    // the community skill and one modifier deleted, one atom added.
    const after = [
      kept,
      fixture({ id: 'modifier/zz-seed-new', tier: 'modifier' }),
      { ...parent, body: 'parent v2' },
      { ...ref, title: 'Ref v2' },
    ]
    const developerOnly = [wire.id]

    const first = planSeed(before, [], {})
    const firstSql = buildMigrationSql(first.upserts, first.versions, first.withdrawn)
    const plan = planSeed(after, developerOnly, first.manifest)
    const incrementalSql = buildMigrationSql(plan.upserts, plan.versions, plan.withdrawn)
    // The seed the generator used to emit: every atom, every developer-only id
    // and the removed community skills.
    const fullSql = buildMigrationSql(after, plan.versions, [...plan.removed.filter((id) => id.startsWith('community/')), ...developerOnly])
    expect(plan.upserts.map((a) => a.id)).not.toContain(kept.id)

    const snapshot = async (client: PoolClient) =>
      (
        await client.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(r) - 'created_at' - 'updated_at' AS row
             FROM public.agent_atom_registry r WHERE r.id LIKE '%/zz-seed-%' ORDER BY r.id`,
        )
      ).rows.map((r) => r.row)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(firstSql)
      await client.query('SAVEPOINT seeded')
      await client.query(incrementalSql)
      const viaIncremental = await snapshot(client)
      await client.query('ROLLBACK TO SAVEPOINT seeded')
      await client.query(fullSql)
      const viaFull = await snapshot(client)

      expect(viaIncremental).toEqual(viaFull)
      const byId = new Map(viaIncremental.map((r) => [r.id as string, r]))
      expect(byId.size).toBe(7)
      expect(byId.get(parent.id)).toMatchObject({ body: 'parent v2', version: 2 })
      expect(byId.get(ref.id)).toMatchObject({ title: 'Ref v2', version: 2 })
      expect(byId.get(kept.id)).toMatchObject({ version: 1, is_active: true })
      expect(byId.get('modifier/zz-seed-new')).toMatchObject({ version: 1, is_active: true })
      expect(byId.get(wire.id)).toMatchObject({ is_active: false, mcp_exposed: false })
      expect(byId.get(community.id)).toMatchObject({ is_active: false, mcp_exposed: false })
      expect(byId.get(deleted.id)).toMatchObject({ is_active: true })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
