-- Third-party transaction enrichment (Gokind counterparty identification).
-- Stores a trimmed projection of the enrichment response, not the raw payload:
-- { provider, fetched_at, identified, counterparty { id, name, org_numbers,
--   logo_url }, industries [], tags [], flags [], payment { subscription,
--   vendor_name } }
-- Nullable: enrichment is optional and fail-soft; rows ingested while the
-- provider is unconfigured or unavailable simply have NULL here.
--
-- Adopted reconciliation migration: this SQL was applied directly to prod on
-- 2026-07-07 (apply-time version 20260707113729) but the file was never
-- committed. Committed after the fact so the prod migration ledger and the
-- repo agree; prod already has the column, so this only runs on fresh
-- branches and staging. See DECISIONS.md 2026-07-08.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS enrichment jsonb;

NOTIFY pgrst, 'reload schema';
