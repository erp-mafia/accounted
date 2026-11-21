-- audit_log: an index for one company's rows of one table, newest first.
--
-- /arkiv/historik reads a company's document_attachments audit rows newest
-- first (lib/arkiv/history.ts). The only matching index was (company_id,
-- created_at DESC, id DESC): the read walked every audit row of the company,
-- journal entries and all, to find the document rows (p95 about 450 ms in
-- production, single reads up to 7.6 s for a company with years of books).
--
-- Built CONCURRENTLY: audit_log takes a row for every audited write, and a
-- plain CREATE INDEX would hold those writes for the minutes the build of a
-- 16 GB table takes. The CLI that applies migrations (supabase 2.119.0) runs
-- a CONCURRENTLY statement outside the migration's transaction and records
-- the version only once it succeeded; the pg-real replay applies files with
-- psql, statement by statement. A build cancelled half-way leaves an invalid
-- index of this name behind, which the next run drops first (on a normal run
-- the drop finds nothing).
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.
--
-- The build reads all of audit_log and takes minutes, past the migration
-- connection's statement_timeout (2 minutes), so the migration lifts the
-- timeout for its own statements and restores it after: a later migration in
-- the same push runs under the usual limit.

SET statement_timeout = 0;

DROP INDEX IF EXISTS public.idx_audit_log_company_table_created;

CREATE INDEX CONCURRENTLY idx_audit_log_company_table_created
  ON public.audit_log (company_id, table_name, created_at DESC);

RESET statement_timeout;
