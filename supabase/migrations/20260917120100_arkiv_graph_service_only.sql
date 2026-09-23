-- Arkiv phase 9b, follow-up: the graph snapshot is served by the app, never
-- read by browser roles.
--
-- Both readers, the Företagshjärnan route and the agent's Accounted://arkiv/graph
-- resource, go through the service client, which also rebuilds a missing or
-- stale snapshot on the way out; a browser role reading the table directly
-- would get a cache without that guarantee. So the browser roles lose their
-- grants and the member policy goes with them. Row level security stays on
-- (the public-schema invariant), and the table is still deleted with its
-- company.

REVOKE ALL ON TABLE public.arkiv_graph_snapshots FROM anon, authenticated;
DROP POLICY IF EXISTS "view own-company arkiv graph" ON public.arkiv_graph_snapshots;

COMMENT ON TABLE public.arkiv_graph_snapshots IS
  'Arkiv phase 9b: the last build of the company graph (nodes with record references, links with evidence). Derived, recomputable, not räkenskapsinformation. Service role only: served through /api/arkiv/brain and the MCP graph resource.';
