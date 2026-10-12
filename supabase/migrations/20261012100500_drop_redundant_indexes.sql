-- Drop 34 redundant indexes in public (the two largest alone are 116 MB on
-- prod).
--
-- Each one is redundant next to an index that stays: every write pays to
-- maintain it, autovacuum scans it, and it holds shared_buffers, for reads
-- another index already serves. Three kinds:
--
--   A. Non-unique exact duplicates of a unique index or constraint. The unique
--      twin serves every lookup the duplicate could (a DESC last column makes
--      no difference: btree scans both ways).
--   B. Left prefixes of a longer index that stays, with 0 scans.
--   C. Legacy (user_id, x) composites from the pre-company schema with 0 scans.
--      The plain user_id index on each of those tables stays: the nightly
--      sandbox cleanup deletes auth.users rows, and the foreign-key probes of
--      those deletes are what scan it.
--
-- Evidence (prod, read-only, 2026-10-11): index stats run from 2026-09-11, a
-- 30-day window with no read replica, so idx_scan is complete. None of these
-- is unique, primary, backing a constraint, the replica identity or clustered,
-- and nothing depends on it. Every foreign key a dropped index served keeps a
-- covering index (tests/pg/drop-redundant-indexes.pg.test.ts asserts that).
--
-- Deliberately kept: idx_journal_entry_lines_entry_id (hot, asserted by
-- tests/pg/db-advisor-lockdowns.pg.test.ts), idx_audit_log_company_id (btree
-- deduplication keeps it far smaller than its superset), the small hot
-- company_id prefixes, idx_whatsapp_link_codes_user (the only cover of its
-- foreign key) and the plain user_id index on every table.
--
-- Not touched: indexes on the tables migration 20261012100400 drops
-- (cost_centers, projects, tax_table_rates, extension_toggles), so the two
-- apply in either order.
--
-- IF EXISTS everywhere: several names exist only on prod, created outside the
-- migration history; fresh-from-migrations databases never had them.
--
-- Plain DROP INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside the
-- migration transaction (precedent 20260710101000). A drop is catalog-only,
-- but it takes an ACCESS EXCLUSIVE lock that this one transaction holds on
-- every table until it commits. lock_timeout makes a drop that queues behind a
-- long-running statement (a SIE import can hold journal_entries for minutes)
-- abort the migration within seconds instead of stalling every reader and
-- writer of the tables already locked; the rerun is safe.
SELECT set_config('lock_timeout', '5s', true);

-- A. Non-unique exact duplicates of a unique index (the unique twin stays).
DROP INDEX IF EXISTS public.idx_account_reconciliations_latest;          -- ux_account_reconciliations_active
DROP INDEX IF EXISTS public.idx_agent_profiles_company;                  -- agent_profiles_company_id_key
DROP INDEX IF EXISTS public.idx_agi_period;                              -- agi_declarations_company_id_period_year_period_month_key
DROP INDEX IF EXISTS public.idx_annual_report_profiles_period;           -- annual_report_profiles_company_period_unique
DROP INDEX IF EXISTS public.idx_annual_report_versions_period;           -- annual_report_versions_number_unique
DROP INDEX IF EXISTS public.idx_bankid_identities_user_id;               -- bankid_identities_user_id_key
DROP INDEX IF EXISTS public.idx_booking_template_embeddings_template_id; -- booking_template_embeddings_template_id_key
DROP INDEX IF EXISTS public.idx_brand_signup_allowlist_brand_email;      -- brand_signup_allowlist_unique_email
DROP INDEX IF EXISTS public.idx_calendar_feeds_feed_token;               -- calendar_feeds_feed_token_key
DROP INDEX IF EXISTS public.idx_company_invitations_token_hash;          -- company_invitations_token_hash_key
DROP INDEX IF EXISTS public.idx_company_settings_company_id;             -- company_settings_company_id_key
DROP INDEX IF EXISTS public.idx_invoice_reminders_action_token;          -- invoice_reminders_action_token_key
DROP INDEX IF EXISTS public.idx_knowledge_documents_hash;                -- knowledge_documents_content_hash_key
DROP INDEX IF EXISTS public.idx_salary_worked_days_employee_date;        -- idx_salary_worked_days_unique
DROP INDEX IF EXISTS public.idx_team_invitations_token_hash;             -- team_invitations_token_hash_key

-- B. Unused left prefixes of a longer index that stays.
DROP INDEX IF EXISTS public.idx_audit_log_user_id;                       -- idx_audit_log_actor_type (user_id, actor_type, created_at)
DROP INDEX IF EXISTS public.idx_accrual_schedules_company;               -- idx_accrual_schedules_company_status
DROP INDEX IF EXISTS public.idx_arsredovisning_narratives_company;       -- arsredovisning_narratives_unique_period
DROP INDEX IF EXISTS public.idx_arsredovisning_sigreq_company;           -- idx_arsredovisning_sigreq_version
DROP INDEX IF EXISTS public.idx_rot_rut_payout_requests_company_id;      -- idx_rot_rut_payout_requests_company_status
DROP INDEX IF EXISTS public.idx_sales_orders_company_id;                 -- idx_sales_orders_company_status
DROP INDEX IF EXISTS public.idx_tax_assessment_notices_company;          -- tax_assessment_notices_company_period_type_date_key
DROP INDEX IF EXISTS public.idx_agi_company;                             -- agi_declarations_company_id_period_year_period_month_key

-- C. Unused legacy (user_id, x) composites; the plain user_id index stays.
DROP INDEX IF EXISTS public.idx_journal_entries_user_date;
DROP INDEX IF EXISTS public.idx_transactions_user_date;
DROP INDEX IF EXISTS public.idx_transactions_unmatched;
DROP INDEX IF EXISTS public.idx_transactions_user_category;
DROP INDEX IF EXISTS public.idx_invoices_user_due_date;
DROP INDEX IF EXISTS public.idx_invoices_user_status;
DROP INDEX IF EXISTS public.idx_invoice_inbox_items_user_created;
DROP INDEX IF EXISTS public.idx_suppliers_name;
DROP INDEX IF EXISTS public.idx_suppliers_is_active;
DROP INDEX IF EXISTS public.idx_deadlines_user_completed;
DROP INDEX IF EXISTS public.idx_deadlines_user_date;
