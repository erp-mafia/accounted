-- Targeted foreign-key indexes for referential-integrity checks.
--
-- Severity: low. This is index hygiene with a real mechanism, not a bug users
-- are hitting. In the 24 h window measured before writing this (2026-09-01) the
-- gateway served 250,838 requests with zero 5xx and a p95 of 63 ms, and
-- GET /api/events, the read path an event_log company index also serves, had
-- zero requests. Nothing here is chasing a live incident.
--
-- The mechanism is real all the same. Deleting a parent row makes Postgres run
-- one referential-integrity probe per inbound foreign key:
--
--   SELECT 1 FROM <child> WHERE <fk_column> = $1 FOR KEY SHARE
--
-- With no index whose leading column is <fk_column>, that probe is a full seq
-- scan of the child table, once per deleted parent row. journal_entries alone
-- has 37 inbound foreign keys and 375,843 deletes since the 2025-12-08 stats
-- reset, which is why supplier_invoices (2,168 rows) carries 725,816 seq scans
-- and 350 M tuples read, and skattekonto_transactions (3,726 rows) 147,102.
-- The heavy delete callers are the replace_sie_import and undo_sie_import RPCs,
-- which is also why pre_request_statement_timeout() already has to ratchet them
-- to 290 s. (import_sie_journal_entries is slower still, but it contains no
-- DELETE at all, so nothing in this migration touches it.)
--
-- Selection rule, applied uniformly against prod on 2026-09-01. Every candidate
-- was checked with EXPLAIN of the probe above plus pg_indexes and
-- pg_stat_user_tables; an index is here only if all three hold:
--
--   1. The prod probe plan is a Seq Scan, or an index scan that only works
--      today because the column happens to be sparse (a full scan of a partial
--      index whose leading column is NOT the fk column).
--   2. The child table has at least ~500 live rows. Below that the whole table
--      is one or two heap pages: a seq scan is cheaper than an index probe, the
--      planner ignores the index anyway, and all the index does is cost writes
--      and raise a fresh unused_index lint. This is why salary_runs is absent
--      despite 491,535 seq scans: 150 rows in 26 pages, and its four FKs to
--      journal_entries are ON DELETE NO ACTION, so a probe is the whole cost.
--      Same for stripe_payouts, stripe_payment_events, vacation_year_closures
--      and rot_rut_payout_requests, all at 0 to 3 rows.
--   3. probe cost x parent n_tup_del >= 2 million planner cost units. That ranks
--      by what the miss actually costs rather than by child row count alone, so
--      a cheap probe against a huge delete count does not outrank an expensive
--      probe against a smaller one. Exactly one index below lands just under
--      that cut; it says so at its own line rather than quietly moving the cut.
--
-- Where the fk column is mostly NULL the index is partial on
-- `WHERE <col> IS NOT NULL`. The RI qual `<col> = $1` implies that predicate, so
-- the planner still gets a plain Index Cond probe (verified on prod:
-- idx_transactions_document_id is partial exactly that way and the probe plans
-- at cost 2.50), and the index then holds only the rows that can actually block
-- a delete. Columns that are NOT NULL, or that have no NULLs in practice, get a
-- plain index.
--
-- Deliberately NOT added, with the prod evidence for each:
--   * transactions (document_id): idx_transactions_document_id is
--     `(document_id) WHERE document_id IS NOT NULL` and the predicate IS
--     implied, so prod already index-scans the probe at cost 2.50. A second
--     index would duplicate it on a 41,239-row table with ~133k writes and
--     manufacture a fresh unused_index lint. Same reasoning excludes
--     invoices (journal_entry_id) at cost 2.49, invoices (converted_from_id),
--     invoice_payments (journal_entry_id) at cost 2.36, and
--     voucher_sequences (fiscal_period_id) at cost 77.73.
--   * transactions (cash_account_id): idx_transactions_cash_account is
--     `(company_id, cash_account_id) WHERE cash_account_id IS NOT NULL`. The
--     fk column is not leading, but the planner still uses it as an index qual
--     and the probe plans at cost 288.59 against 1,234 cash_accounts deletes,
--     which is 0.4 M cost units, far below the rule 3 line.
--   * invoice_inbox_items (matched_transaction_id): same shape via
--     idx_inbox_items_matched_transaction, probe cost 23.13. 0.4 M cost units.
--   * the 55 unused indexes and the 81 auth_rls_initplan lints in the same
--     advisor run: ~9 MB in a 3,250 MB database, and the largest initplan-flagged
--     table is 13,580 rows, none of them the hot tenant tables. Both are
--     separate decisions, not this migration.
--   * public._backfill_remaining_20260817 is not drift and is not touched here:
--     shipped migration 20260825170000 lock_down_invoice_backfill_snapshot
--     already covers it, and its 337 rows are rollback evidence for the
--     2026-08-17 invoice repair.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Supabase branching applies migrations
-- inside a transaction, where CONCURRENTLY is not allowed, and this repo has no
-- CONCURRENTLY DDL anywhere for that reason. Every build here is on a table of
-- 45k rows or fewer except event_log (266,103 rows / 149 MB), which takes a
-- short write-blocking lock; the partial indexes cover a few hundred rows each.

-- companies (1,460 deletes) -> event_log (266,103 rows), ON DELETE CASCADE.
-- Prod probe: Seq Scan cost 22,335.69. event_log has no index containing
-- company_id at all: event_log_pkey(sequence), idx_event_log_created_at,
-- idx_event_log_type_created(event_type, created_at) and
-- idx_event_log_user_seq(user_id, sequence). company_id has no NULLs, so the
-- index is plain, and the trailing `sequence` makes it serve the cursor read in
-- app/api/events/route.ts and the company_id RLS predicate as well. Justified by
-- the cascade and by plan correctness as the table grows, not by read traffic:
-- that route had zero requests in the measured window against 5,395 inserts a
-- day. It does NOT help the retention cron DELETE, whose predicate is
-- `created_at < cutoff AND event_type NOT LIKE ...`; idx_event_log_created_at
-- already serves that one.
CREATE INDEX IF NOT EXISTS idx_event_log_company_sequence
  ON public.event_log (company_id, sequence);

-- journal_entries (375,843 deletes) -> sie_imports (1,278 rows).
-- Prod probe: Seq Scan cost 172.91. 71% NULL.
CREATE INDEX IF NOT EXISTS idx_sie_imports_opening_balance_entry
  ON public.sie_imports (opening_balance_entry_id)
  WHERE opening_balance_entry_id IS NOT NULL;

-- journal_entries (375,843 deletes) -> skattekonto_transactions (3,726 rows).
-- Prod probe: Seq Scan cost 135.21. 87% NULL.
CREATE INDEX IF NOT EXISTS idx_skattekonto_transactions_je
  ON public.skattekonto_transactions (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

-- journal_entries (375,843 deletes) -> skattekonto_transactions (3,726 rows).
-- Prod probe: Seq Scan cost 135.21. 90% NULL. The existing
-- idx_skattekonto_transactions_suggested_open leads on company_id and carries an
-- extra `journal_entry_id IS NULL` conjunct, so it cannot serve this probe.
CREATE INDEX IF NOT EXISTS idx_skattekonto_transactions_suggested_je
  ON public.skattekonto_transactions (suggested_journal_entry_id)
  WHERE suggested_journal_entry_id IS NOT NULL;

-- journal_entries (375,843 deletes) -> supplier_invoices (2,168 rows).
-- Prod probe: Seq Scan cost 113.90. 84% NULL. The existing
-- idx_supplier_invoices_payment_je_doc leads on the right column but is partial
-- on `document_id IS NOT NULL`, which the RI qual does NOT imply, so it is not
-- usable here. It stays: it serves a different, document-scoped lookup.
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_payment_je
  ON public.supplier_invoices (payment_journal_entry_id)
  WHERE payment_journal_entry_id IS NOT NULL;

-- journal_entries (375,843 deletes) -> supplier_invoices (2,168 rows).
-- Prod probe: Seq Scan cost 113.90. 79% NULL. Same story as the payment leg:
-- idx_supplier_invoices_registration_je_doc is partial on document_id.
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_registration_je
  ON public.supplier_invoices (registration_journal_entry_id)
  WHERE registration_journal_entry_id IS NOT NULL;

-- journal_entries (375,843 deletes) -> transactions (41,239 rows).
-- Prod probe today is an Index Scan at cost 13.38, but only by luck:
-- idx_transactions_potential_je is `(company_id) WHERE
-- potential_journal_entry_id IS NOT NULL`, so the planner reads the whole index
-- and applies the fk column as a Filter. That is cheap only while the column is
-- 99.98% NULL (about 7 rows today). As match suggestions fill in, the probe cost
-- grows linearly with the number of suggested transactions, times 375,843
-- deletes. This index makes it a real probe instead. The company_id one stays:
-- it serves the company-scoped "transactions with a suggestion" listing.
CREATE INDEX IF NOT EXISTS idx_transactions_potential_journal_entry
  ON public.transactions (potential_journal_entry_id)
  WHERE potential_journal_entry_id IS NOT NULL;

-- invoices (7,579 deletes) -> transactions (41,239 rows).
-- Prod probe: Seq Scan cost 2,057.30. 99.5% NULL.
CREATE INDEX IF NOT EXISTS idx_transactions_invoice_id
  ON public.transactions (invoice_id)
  WHERE invoice_id IS NOT NULL;

-- invoices (7,579 deletes) -> transactions (41,239 rows).
-- Prod probe: Seq Scan cost 2,057.30. 99.97% NULL.
CREATE INDEX IF NOT EXISTS idx_transactions_potential_invoice_id
  ON public.transactions (potential_invoice_id)
  WHERE potential_invoice_id IS NOT NULL;

-- invoices (7,579 deletes) -> invoices (13,632 rows), self-referencing credit
-- notes. Prod probe: Seq Scan cost 604.05. 99.8% NULL.
CREATE INDEX IF NOT EXISTS idx_invoices_credited_invoice_id
  ON public.invoices (credited_invoice_id)
  WHERE credited_invoice_id IS NOT NULL;

-- document_attachments (2,841 deletes) -> document_attachments (34,607 rows),
-- the version chain. Prod probe: Seq Scan cost 4,886.29. 99.9% NULL.
CREATE INDEX IF NOT EXISTS idx_document_attachments_superseded_by_id
  ON public.document_attachments (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

-- auth.users (1,730 deletes) -> document_attachments (34,607 rows).
-- Prod probe: Seq Scan cost 4,886.29. No NULLs in practice, so plain.
CREATE INDEX IF NOT EXISTS idx_document_attachments_uploaded_by
  ON public.document_attachments (uploaded_by);

-- supplier_invoices (4,853 deletes) -> invoice_inbox_items (9,457 rows).
-- Prod probe: Seq Scan cost 1,582.67. 97% NULL.
CREATE INDEX IF NOT EXISTS idx_inbox_items_created_supplier_invoice
  ON public.invoice_inbox_items (created_supplier_invoice_id)
  WHERE created_supplier_invoice_id IS NOT NULL;

-- customers (4,932 deletes) -> deadlines (6,918 rows).
-- Prod probe: Seq Scan cost 1,526.90 over 1,442 heap pages. The column is 100%
-- NULL today, so the partial index is empty: it costs nothing to maintain and
-- turns every customer deletion's probe into an empty-index lookup.
CREATE INDEX IF NOT EXISTS idx_deadlines_customer_id
  ON public.deadlines (customer_id)
  WHERE customer_id IS NOT NULL;

-- suppliers (3,000 deletes) -> invoice_inbox_items (9,457 rows).
-- Prod probe: Seq Scan cost 1,582.67. 95% NULL.
CREATE INDEX IF NOT EXISTS idx_inbox_items_matched_supplier
  ON public.invoice_inbox_items (matched_supplier_id)
  WHERE matched_supplier_id IS NOT NULL;

-- document_attachments (2,841 deletes) -> invoice_inbox_items (9,457 rows).
-- Prod probe: Seq Scan cost 1,582.67. Only 1.2% NULL, so plain.
CREATE INDEX IF NOT EXISTS idx_inbox_items_document_id
  ON public.invoice_inbox_items (document_id);

-- auth.users (1,730 deletes) -> journal_entry_no_doc_required (44,365 rows),
-- ON DELETE RESTRICT, so the probe runs on every attempted user deletion.
-- Prod probe: Seq Scan cost 1,356.56 over 809 heap pages. Column is NOT NULL.
CREATE INDEX IF NOT EXISTS idx_jenodoc_user
  ON public.journal_entry_no_doc_required (user_id);

-- transactions (17,162 deletes) -> supplier_invoices (2,168 rows).
-- Prod probe: Seq Scan cost 113.90. 90% NULL. This is the one entry below the
-- rule 3 cut: 113.90 x 17,162 is 1.95 M cost units, not 2 M. Kept anyway as the
-- third probe against the table already showing 725,816 seq scans and 350 M
-- tuples read, on which the other two indexes here are already paying the write
-- cost; the partial index is ~214 rows.
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_transaction_id
  ON public.supplier_invoices (transaction_id)
  WHERE transaction_id IS NOT NULL;
