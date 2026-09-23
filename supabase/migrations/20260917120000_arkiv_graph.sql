-- Arkiv phase 9b: the graph read model, one snapshot per company.
--
-- The graph is never a second truth: it is rebuilt from the ledger, the
-- parties, the agreements, the documents and the facts, and this table only
-- caches the last build so the page and an agent read the same picture at
-- the same instant. Members read it; the service role writes it.

CREATE TABLE public.arkiv_graph_snapshots (
  company_id   uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  graph        jsonb NOT NULL,
  node_count   integer NOT NULL DEFAULT 0,
  link_count   integer NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  -- set by the pipeline when a document lands or a derivation runs; the next read rebuilds
  stale        boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.arkiv_graph_snapshots IS
  'Arkiv phase 9b: the last build of the company graph (nodes with record references, links with evidence). Derived, recomputable, not räkenskapsinformation.';

ALTER TABLE public.arkiv_graph_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company arkiv graph"
  ON public.arkiv_graph_snapshots FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
