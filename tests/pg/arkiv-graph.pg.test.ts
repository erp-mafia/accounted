import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 9b. The graph snapshot is one row per company that only the
 * service reads and writes (the app serves it through its own route and the
 * agent resource), and it goes with the company.
 */
describe('arkiv_graph_snapshots', () => {
  it('is closed to browser roles, written by the service only, and refreshed in place', async () => {
    const { userId, companyId } = await seedCompany()
    const stranger = await insertAuthUser()
    await getPool().query(`INSERT INTO public.arkiv_graph_snapshots (company_id, graph, node_count, link_count) VALUES ($1, '{"nodes": [], "links": []}', 0, 0)`, [companyId])
    await expect(
      getPool().query(`INSERT INTO public.arkiv_graph_snapshots (company_id, graph) VALUES ($1, '{}')`, [companyId]),
    ).rejects.toThrow(/arkiv_graph_snapshots_pkey/)

    // A member cannot read the cache directly: the route rebuilds a stale or missing snapshot on the way out, a raw read would not.
    await expect(withUserContext(userId, (client) => client.query(`SELECT node_count FROM public.arkiv_graph_snapshots WHERE company_id = $1`, [companyId]))).rejects.toThrow(/permission denied/i)
    await expect(withUserContext(stranger, (client) => client.query(`SELECT node_count FROM public.arkiv_graph_snapshots WHERE company_id = $1`, [companyId]))).rejects.toThrow(/permission denied/i)
    await expect(withUserContext(userId, (client) => client.query(`UPDATE public.arkiv_graph_snapshots SET stale = true WHERE company_id = $1`, [companyId]))).rejects.toThrow(/permission denied/i)
    const rls = await getPool().query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.arkiv_graph_snapshots'::regclass`)
    expect(rls.rows).toEqual([{ relrowsecurity: true }])
    // The service upserts in place: one row per company, refreshed rather than duplicated.
    await getPool().query(`INSERT INTO public.arkiv_graph_snapshots (company_id, graph, node_count) VALUES ($1, '{"nodes": [1]}', 1) ON CONFLICT (company_id) DO UPDATE SET graph = EXCLUDED.graph, node_count = EXCLUDED.node_count, stale = false, computed_at = now()`, [companyId])
    const after = await getPool().query(`SELECT node_count, stale FROM public.arkiv_graph_snapshots WHERE company_id = $1`, [companyId])
    expect(after.rows).toEqual([{ node_count: 1, stale: false }])
  })
})
