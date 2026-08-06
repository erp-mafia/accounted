-- set_committed_at() (migration 017) stamped committed_at := now() on every
-- draft-to-posted transition, discarding any committed_at the row already
-- carried. No production writer supplies one (the engine leaves drafts NULL
-- and commit_journal_entry never writes the column), but seeding flows that
-- backdate history (sandbox seed, seed-demo-account, seed-export-data) now
-- post drafts whose committed_at is the historical booking time, and stamping
-- now() over it makes every seeded verifikat look booked today, skewing the
-- booking-lag stats and audit views the demo exists to show.
--
-- Stamp only when the column is NULL. A posted entry still always ends up
-- with a non-null committed_at (the invariant get_ledger_usage_stats and the
-- lag reports rely on); an explicitly supplied value is now honored instead
-- of silently overwritten.
CREATE OR REPLACE FUNCTION public.set_committed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.committed_at IS NULL THEN
    NEW.committed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
