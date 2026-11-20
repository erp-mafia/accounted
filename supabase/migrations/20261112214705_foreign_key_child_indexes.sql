-- Foreign keys to companies and auth.users whose child table has no index on
-- the key: deleting one parent row reads each child table whole.
--
-- Postgres checks every foreign key when a company or a user is deleted, with
-- "SELECT 1 FROM <child> WHERE <key> = $1" (and deletes by the same key where
-- the constraint cascades). Where the child has no index that starts with
-- that key, the check is a Seq Scan of the child, once per deleted parent.
-- The nightly sandbox cleanup (/api/sandbox/cleanup/cron,
-- cleanup_expired_sandbox_users -> cleanup_sandbox_user, ten users per call)
-- deletes users and their companies in bulk and pays for all of them: the
-- call takes seconds, most of it in these checks.
--
-- The lookups below are the ones behind that, each a sequential scan of
-- the whole child table per deleted parent (RI checks never run parallel):
--   party_facts.user_id
--   parties.user_id
--   sie_import_chunks.user_id
--   document_jobs.company_id
--   categorization_templates.user_id
--   payment_match_log.company_id
--   suggestion_log.resolved_by
--   (document_classifications, for its two keys: 20261112214704)
-- The cost is the child tables' size times the users deleted, and both grow
-- over time: left alone, fewer batches fit the cron's 240 s budget each
-- night, and expired sandboxes pile up.
--
-- With an index on each key the check is one probe per table.
--
-- Two of the keys are nearly always NULL, so their indexes hold only the
-- rows that have one (a strict "key = $1" proves the predicate):
--   categorization_templates.user_id   (company-scoped since
--     20260330130000; 20260711100000 dropped the old full index because no
--     query reads by user_id, which is true of queries and not of the
--     foreign key. The name is reused; the index is now partial.)
--   payment_match_log.company_id
-- suggestion_log.resolved_by is set on every row today; its index is plain.
--
-- Plain CREATE INDEX, not CONCURRENTLY (precedent 20261031110200). Each
-- build takes a SHARE lock on its table, held until the migration commits:
-- reads go on, writes to that table wait. The largest heaps are party_facts,
-- parties, sie_import_chunks and document_jobs; expect a few seconds in
-- all. A table built early waits for every build
-- after it, so the three small ones go first and parties and party_facts,
-- which every party suggestion writes to, go last.
--
-- Each build also waits for its lock behind any write transaction already
-- open on its table, while the tables built before it stay locked. The
-- nightly sandbox cleanup (04:00 UTC) writes to several of these tables in
-- one transaction and deletes from the rest at its end, so the two can wait
-- on each other. lock_timeout caps every wait at 5 s: past it the migration
-- fails whole and is run again (IF NOT EXISTS) instead of holding writes on
-- seven tables.
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_categorization_templates_user_id
  ON public.categorization_templates (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_match_log_company_id
  ON public.payment_match_log (company_id)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_suggestion_log_resolved_by
  ON public.suggestion_log (resolved_by);

CREATE INDEX IF NOT EXISTS idx_document_jobs_company_id
  ON public.document_jobs (company_id);

CREATE INDEX IF NOT EXISTS idx_sie_import_chunks_user_id
  ON public.sie_import_chunks (user_id);

CREATE INDEX IF NOT EXISTS idx_parties_user_id
  ON public.parties (user_id);

CREATE INDEX IF NOT EXISTS idx_party_facts_user_id
  ON public.party_facts (user_id);
