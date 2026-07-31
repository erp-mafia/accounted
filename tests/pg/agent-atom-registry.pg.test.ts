import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { withUserContext } from '@/tests/pg/setup'

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
    // on this (no disk fallback in prod).
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
