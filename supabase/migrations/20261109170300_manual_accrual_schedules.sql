-- accounted#164: a periodisering can come from a posted verifikat or an
-- opening balance instead of an invoice line. Existing rows are invoice plans.
--
-- A manual plan dissolves into a resultatkonto (3xxx-8xxx). Invoice plans keep
-- the wider class 1-8 range of accrual_schedules_target_account_range: their
-- target is the invoice line's own account.
--
-- origin_journal_entry_id is indexed for manual plans: reversing a verifikat
-- looks up the manual plans it is the origin of and cancels them
-- (src/lib/bookkeeping/accruals/origin-reversal.ts).
--
-- pg-test: tests/pg/manual-accrual-schedules.pg.test.ts
ALTER TABLE public.accrual_schedules
  ADD COLUMN source_kind text NOT NULL DEFAULT 'invoice'
    CHECK (source_kind IN ('invoice', 'manual'));

ALTER TABLE public.accrual_schedules
  DROP CONSTRAINT accrual_schedules_one_source,
  DROP CONSTRAINT accrual_schedules_direction_matches_source;

ALTER TABLE public.accrual_schedules
  ADD CONSTRAINT accrual_schedules_one_source CHECK (
    (supplier_invoice_id IS NOT NULL)::int + (invoice_id IS NOT NULL)::int
      + (source_kind = 'manual')::int = 1
  ),
  ADD CONSTRAINT accrual_schedules_direction_matches_source CHECK (
    (direction = 'expense' AND (supplier_invoice_id IS NOT NULL OR source_kind = 'manual'))
    OR (direction = 'revenue' AND (invoice_id IS NOT NULL OR source_kind = 'manual'))
  ),
  ADD CONSTRAINT accrual_schedules_source_kind_matches_invoice CHECK (
    (source_kind = 'invoice' AND (supplier_invoice_id IS NOT NULL OR invoice_id IS NOT NULL))
    OR (source_kind = 'manual' AND supplier_invoice_id IS NULL AND invoice_id IS NULL)
  ),
  ADD CONSTRAINT accrual_schedules_manual_target_result_account CHECK (
    source_kind <> 'manual' OR target_account ~ '^[3-8][0-9]{3}$'
  );

CREATE INDEX idx_accrual_schedules_manual_origin
  ON public.accrual_schedules (origin_journal_entry_id)
  WHERE source_kind = 'manual' AND origin_journal_entry_id IS NOT NULL;

COMMENT ON COLUMN public.accrual_schedules.source_kind IS
  'invoice for a plan created from an invoice line; manual for a plan created from a posted verifikat or an opening balance. accounted#164.';

NOTIFY pgrst, 'reload schema';
