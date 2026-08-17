-- Skatteverket connections are per (user, company).
--
-- The table historically carried two half-finished uniqueness models stacked
-- on top of each other:
--   * 20260330130000 replaced UNIQUE(user_id) with UNIQUE(company_id)
--   * 20260428120000 re-added UNIQUE(user_id) (its guard only looked for a
--     (user_id) unique constraint, so it did not see the company one)
-- leaving BOTH single-column constraints in place: one row per user AND one
-- row per company. A multi-company operator could therefore never hold a
-- connection for more than one of their companies, and reconnecting while
-- another company was active silently moved the single row (the app's
-- DELETE-by-user + INSERT-with-active-company pattern), going dark on the
-- original company's nightly sync.
--
-- The application now reads and writes token rows scoped by
-- (user_id, company_id); this migration makes the schema say the same thing.
-- Legacy rows with NULL company_id (pre-multi-tenant) are left in place: the
-- scoped reads never match them, so those users simply reconnect per company.

ALTER TABLE public.skatteverket_tokens
  DROP CONSTRAINT IF EXISTS skatteverket_tokens_user_id_key;

ALTER TABLE public.skatteverket_tokens
  DROP CONSTRAINT IF EXISTS skatteverket_tokens_company_id_key;

ALTER TABLE public.skatteverket_tokens
  ADD CONSTRAINT skatteverket_tokens_user_id_company_id_key UNIQUE (user_id, company_id);

NOTIFY pgrst, 'reload schema';
