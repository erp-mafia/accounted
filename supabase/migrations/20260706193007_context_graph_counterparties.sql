-- Context graph (knowledge graph read model), step 1: counterparty nodes.
--
-- graph_counterparties + graph_transaction_counterparties materialize the ONE
-- edge the ledger lacks as a FK: bank transaction -> counterparty (transactions
-- only carry free-text merchant_name/description). Every other context-graph
-- edge (transaction -> journal entry -> accounts/documents, invoice links,
-- receipts, templates) is derived at query time from existing FKs in
-- lib/graph/subgraph.ts.
--
-- DERIVED READ MODEL, not a system of record and not rakenskapsinformation:
-- rows are rebuildable at any time from base tables via
-- scripts/rebuild-context-graph.ts (lib/graph/rebuild.ts). Therefore:
--   - DELETE is allowed (RLS policy included on purpose)
--   - no immutability trigger, no audit trigger
--   - core tables must never grow FKs pointing INTO these tables
--
-- Edges live in their own table (not a column on transactions) so the whole
-- projection stays separable and truncatable.
--
-- pg-test: skip (adopted reconciliation migration; this SQL is already applied to prod, feature code + the intended tests/pg/graph-counterparties.pg.test.ts were never merged to main, tracked separately)

CREATE TABLE public.graph_counterparties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Output of normalizeCounterpartyName() (lib/bookkeeping/counterparty-templates.ts)
  normalized_name text NOT NULL,
  -- formatCounterpartyName(normalized_name), e.g. "Telia Sverige AB"
  display_name    text NOT NULL,
  -- Best-effort links to master data when resolution finds a match.
  supplier_id     uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  template_id     uuid REFERENCES public.categorization_templates(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, normalized_name)
);

CREATE TABLE public.graph_transaction_counterparties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transaction_id    uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  counterparty_id   uuid NOT NULL REFERENCES public.graph_counterparties(id) ON DELETE CASCADE,
  resolution_method text NOT NULL CHECK (resolution_method IN
    ('exact_alias', 'exact_normalized', 'fuzzy', 'supplier_link', 'customer_link', 'normalized_only')),
  confidence        numeric NOT NULL DEFAULT 0,
  source            text NOT NULL CHECK (source IN ('rebuild', 'event', 'lazy')),
  resolved_at       timestamptz NOT NULL DEFAULT now(),

  -- One counterparty per transaction (v1).
  UNIQUE (transaction_id)
);

ALTER TABLE public.graph_counterparties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_transaction_counterparties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company graph_counterparties"
  ON public.graph_counterparties FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company graph_counterparties"
  ON public.graph_counterparties FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company graph_counterparties"
  ON public.graph_counterparties FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company graph_counterparties"
  ON public.graph_counterparties FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "view own-company graph_transaction_counterparties"
  ON public.graph_transaction_counterparties FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company graph_transaction_counterparties"
  ON public.graph_transaction_counterparties FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company graph_transaction_counterparties"
  ON public.graph_transaction_counterparties FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company graph_transaction_counterparties"
  ON public.graph_transaction_counterparties FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

-- Drives "similar transactions with the same counterparty".
CREATE INDEX idx_gtc_company_counterparty
  ON public.graph_transaction_counterparties (company_id, counterparty_id);

CREATE TRIGGER set_updated_at_graph_counterparties
  BEFORE UPDATE ON public.graph_counterparties
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.graph_counterparties IS
  'Context-graph read model: counterparty nodes derived from transaction merchant names. Rebuildable projection (scripts/rebuild-context-graph.ts), NOT rakenskapsinformation; deletes allowed by design.';
COMMENT ON TABLE public.graph_transaction_counterparties IS
  'Context-graph read model: transaction -> counterparty edges with resolution provenance. Rebuildable projection, NOT rakenskapsinformation; deletes allowed by design.';

NOTIFY pgrst, 'reload schema';
