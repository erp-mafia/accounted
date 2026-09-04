-- Parties, phase 0: prerequisites for the counterparty resolver.
--
-- 1. pg_trgm for trigram blocking of counterparty keys. Candidate generation
--    runs before any model call and must be cheap; trigram similarity over
--    normalised voucher and bank text is the first stage. Installed in the
--    `extensions` schema like the other Supabase extensions in this repo.
--
-- 2. Drop the two context-graph tables from 20260706193007. Their feature
--    code (lib/graph/) was never merged and the tables were dropped on prod
--    during the context-graph revert, so every fresh replay (CI, preview
--    branches, local stacks) has been creating two tables prod does not have.
--    The parties layer keys the same identity (company_id + normalised name)
--    and must not coexist with a second, divergent substrate. Child first:
--    graph_transaction_counterparties references graph_counterparties.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

DROP TABLE IF EXISTS public.graph_transaction_counterparties;
DROP TABLE IF EXISTS public.graph_counterparties;
