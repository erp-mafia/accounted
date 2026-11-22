-- document_attachments: one company's rows in id order, for the underlag
-- import's read of the documents a company already has.
--
-- Every slice of the provider underlag import (arcim-migration,
-- lib/import-documents.ts) reads all of the company's attachment rows first,
-- a thousand a page in id order. The only index on company_id made every page
-- fetch and sort all of the company's rows (26 000 rows in 7 300 heap blocks
-- a page for the largest archive in production, 27 pages a slice), and a page
-- that met a cold cache passed the 8 s statement timeout. With this index the
-- read pages by keyset: each page is the range of the next thousand ids.
--
-- Built CONCURRENTLY so uploads and the import keep writing during the
-- build; the CLI that applies migrations runs it outside the migration's
-- transaction, and a half-built index left by a cancelled run is dropped
-- first (on a normal run the drop finds nothing).
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.
--
-- The table is about 0.6 GB and the build should take well under a minute,
-- but a concurrent build also waits for every transaction older than it, and
-- the migration connection's statement_timeout is 2 minutes. As in
-- 20261120134000_audit_log_company_table_created_index, the migration lifts
-- the timeout for its own statements and restores it after, so a later
-- migration in the same push runs under the usual limit.

SET statement_timeout = 0;

DROP INDEX IF EXISTS public.idx_document_attachments_company_id_id;

CREATE INDEX CONCURRENTLY idx_document_attachments_company_id_id
  ON public.document_attachments (company_id, id);

RESET statement_timeout;
