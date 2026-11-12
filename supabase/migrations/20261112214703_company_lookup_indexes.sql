-- bank_connections, mapping_rules, supplier_invoice_payments: a company's
-- rows by company.
--
-- All three tables are read "WHERE company_id = $1" on hot paths and none had
-- an index that starts with company_id, so every such read scans every
-- company's rows. They are small today, which is why nobody noticed; the cost
-- of one lookup grows with the number of companies, and so does the number of
-- lookups. On production (read-only EXPLAIN ANALYZE, 2026-11-12; about
-- 3 800 companies):
--
-- bank_connections (2 136 rows, 293 pages; indexes on id, user_id,
-- (status, last_synced_at), oauth_state, superseded_by, session_id):
--   Hem, the worklist badges, the notices and /api/v1 bank-connections read
--   a company's connections on every render (39 statement shapes, 469 000
--   calls since 2026-09-11, mean 2.9 ms), and
--   lock_cash_account_booking_state() and guard_bank_booking_context() run
--   "WHERE company_id = $1 ORDER BY id FOR SHARE" on every bank row booked.
--   Each is a Seq Scan of all 2 136 rows for the 0 to 3 it wants: 5.4 ms and
--   968 buffers as a signed-in user, 1.8 ms and 296 buffers inside the lock
--   function. The table has 477 000 sequential scans on record, 727 M rows
--   read. At ten times the companies that is 2 900 pages, 15 to 20 ms,
--   several times per page view and per booking. (company_id, id) serves
--   the filter and the lock function's ORDER BY id.
--
-- mapping_rules (3 204 rows, 163 pages, 226 companies; indexes on id,
-- priority, rule_type, user_id, (user_id, merchant_pattern, source)):
--   every booking proposal reads the company's active rules by priority and
--   then the global ones (company_id IS NULL), lib/transactions/propose.ts and
--   lib/bookkeeping/mapping-engine.ts: about 181 000 calls since 2026-09-11.
--   Each reads the whole table (2.2 ms, 253 buffers, 3 204 rows for 0
--   returned), or walks idx_mapping_rules_priority across all companies
--   (10 817 scans, 22.9 M entries read). (company_id, priority) serves
--   propose.ts's two reads directly: the company's rules already in priority
--   order, and the global ones as one probe (there are none today).
--   mapping-engine.ts asks for both in one statement ("company_id = $1 OR
--   company_id IS NULL" by priority): two probes of the same index and a
--   sort of the company's own few rules, not of the table.
--
-- supplier_invoice_payments (about 3 200 rows, 71 pages; indexes on id,
-- supplier_invoice_id, journal_entry_id, (transaction_id, supplier_invoice_id)):
--   read by company and payment date (lib/core/bookkeeping/kontantmetod-cutoff.ts,
--   and a "company_id = $1 AND payment_date >= $2" read with 5 785 calls at
--   97 blocks each) and by company alone as one arm of the bank_row_anchors
--   view, which the planner filters with a Seq Scan (the table has 88 253
--   sequential scans on record). Harmless at 71 pages; (company_id,
--   payment_date) keeps the cost from growing with the table.
--
-- idx_mapping_rules_priority stays: dropping it is a separate, later step
-- once its idx_scan shows nothing else walks it.
--
-- Plain CREATE INDEX, not CONCURRENTLY (precedent 20261031110200). The
-- tables are 2.3 MB, 1.3 MB and 0.6 MB: each build holds its SHARE lock for
-- a few milliseconds. Getting the lock can take longer: a build waits behind
-- any write transaction already open on its table, and every booking that
-- arrives after it queues behind it. lock_timeout caps that wait at 5 s;
-- past it the migration fails whole and is run again (IF NOT EXISTS).
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_bank_connections_company_id
  ON public.bank_connections (company_id, id);

CREATE INDEX IF NOT EXISTS idx_mapping_rules_company_priority
  ON public.mapping_rules (company_id, priority);

CREATE INDEX IF NOT EXISTS idx_supplier_invoice_payments_company_date
  ON public.supplier_invoice_payments (company_id, payment_date);
