import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { withUserContext } from '@/tests/pg/setup'

describe('agent_atom_registry.pg — seed + RLS', () => {
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
    // Every active atom has a real body inlined — the production read path depends
    // on this (no disk fallback in prod).
    for (const r of rows) {
      expect(r.body, `atom ${r.id} body should be non-empty`).toBeTruthy()
      expect(r.mcp_exposed).toBe(true)
    }
    // swarm-* audit skills must never become atoms; a curated horizontal must be present.
    expect(rows.some((r) => r.id.includes('swarm'))).toBe(false)
    expect(rows.some((r) => r.id === 'horizontal/swedish-vat')).toBe(true)
  })

  it('authenticated users can read the catalog but not write it', async () => {
    const { userId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const sel = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.agent_atom_registry`,
      )
      expect(sel.rows[0]!.n).toBeGreaterThan(0)

      // No INSERT policy for authenticated — the catalog ships via service-role
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
