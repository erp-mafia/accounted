-- F-skatt deadline re-gating (issue #1028) + durable deadline dismissal.
--
-- Approval for F-skatt carries no recurring obligation: the recurring duty is
-- PAYMENT of debiterad preliminarskatt, and only when Skatteverket has debited
-- an amount > 0 kr (below 2 400 kr nothing is debited at all, SFL 55 kap. 2 §).
-- The deadline generator previously gated on the f_skatt approval flag, whose
-- column default is true, so nearly every company received 12 payment
-- reminders per year for a tax that may not be debited. The generator now
-- gates on preliminary_tax_monthly > 0 instead.

-- 1) Schema alignment: preliminary_tax_monthly has existed on the hosted
--    database since before migration discipline, but no migration ever
--    declared it. Installs built purely from migrations (self-hosted, local,
--    preview branches) lack the column and fail every tax-settings save that
--    includes the field. No-op on hosted.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS preliminary_tax_monthly numeric;

-- 2) Durable dismissal for system-generated deadlines. Hard-deleting a system
--    row never worked: the nightly backfill cron treats the missing row as a
--    repair case and recreates it within 24 hours. A dismissed row stays in
--    the table, is hidden from every surface, and satisfies the generator and
--    backfill the same way a completed row does.
ALTER TABLE public.deadlines
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

-- 3) Prune upcoming F-skatt payment reminders for companies with no debited
--    preliminary tax on record. Completed rows are kept (filing history).
DELETE FROM public.deadlines d
WHERE d.source = 'system'
  AND d.tax_deadline_type = 'f_skatt'
  AND d.is_completed = false
  AND d.due_date >= current_date
  AND NOT EXISTS (
    SELECT 1
    FROM public.company_settings cs
    WHERE cs.company_id = d.company_id
      AND coalesce(cs.preliminary_tax_monthly, 0) > 0
  );

NOTIFY pgrst, 'reload schema';
