-- Skattereduktion för grön teknik as a third deduction kind (crm#209, #3135).
--
-- An invoice line can now carry deduction_type 'gron_teknik' next to 'rot'
-- and 'rut': Skatteverket's tax reduction for installing solceller (15 %),
-- system för lagring av egenproducerad elenergi (50 %) and laddningspunkt
-- till elfordon (50 %), computed on arbete och material including moms. It
-- is invoiced through the same fakturamodell and booked through the same
-- 1513 split receivable as ROT/RUT, so only the stored kind is new.
--
-- Both columns that store the kind accept it, so neither a write today nor a
-- begäran, settle, reclaim or bank match on a grön teknik invoice later can
-- fail on a constraint:
--   * invoice_items.deduction_type (20260526121700_rot_rut_avdrag.sql);
--   * rot_rut_payout_requests.deduction_type
--     (20260703090000_rot_rut_payout_requests.sql: an inline column CHECK,
--     named rot_rut_payout_requests_deduction_type_check by Postgres).
--
-- Names are kept for wire stability (founder decision on #3135): the
-- rot_rut_* tables, routes and columns stay, the kind is the new value. No
-- function, trigger or view branches on the kind
-- (enforce_single_active_rot_rut_request, the beslut, settle, reclaim and
-- link-voucher RPCs are kind-agnostic), and articles.housework_type is free
-- text validated by the API, so nothing else changes.
--
-- Re-adding the CHECK on invoice_items rescans the table under the lock the
-- ALTER takes; the test is a cheap per-row comparison, so expect a short
-- write pause at deploy. Applied through the merge flow only.
--
-- pg-real coverage: tests/pg/gron-teknik-deduction-type.pg.test.ts

ALTER TABLE public.invoice_items
  DROP CONSTRAINT IF EXISTS invoice_items_deduction_type_check;
ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_deduction_type_check
  CHECK (deduction_type IS NULL OR deduction_type IN ('rot', 'rut', 'gron_teknik'));

ALTER TABLE public.rot_rut_payout_requests
  DROP CONSTRAINT IF EXISTS rot_rut_payout_requests_deduction_type_check;
ALTER TABLE public.rot_rut_payout_requests
  ADD CONSTRAINT rot_rut_payout_requests_deduction_type_check
  CHECK (deduction_type IN ('rot', 'rut', 'gron_teknik'));

NOTIFY pgrst, 'reload schema';
