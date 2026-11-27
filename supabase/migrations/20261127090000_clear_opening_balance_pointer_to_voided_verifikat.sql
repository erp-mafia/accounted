-- A fiscal year no longer names a voided verifikat as its ingående balans.
--
-- fiscal_periods.opening_balance_entry_id names the year's IB verifikat.
-- Some years name a verifikat whose status is 'cancelled' or 'draft': it was
-- voided before the posted-to-cancelled transition was gated
-- (20260929220100), and the pointer stayed. The journal does not carry such a
-- verifikat (every sum counts 'posted' and 'reversed' entries only), but the
-- readers of the pointer take its lines as the year's opening balance, and
-- the "one IB per year" check counts it as an existing IB.
--
-- This migration clears those pointers once. The year then reads as a year
-- without a linked IB does: it opens on the balances derived from the
-- earlier years, and on a posted IB verifikat that is not linked when there
-- is one, and a new IB can be booked.
--
-- Left as they are:
--   * a pointer to a 'posted' IB verifikat;
--   * a pointer to a 'reversed' one: its storno is a movement in the year,
--     so the year's closing balances are right as they stand;
--   * every company archived by a migration reset
--     (.claude/rules/database.md, rule 9);
--   * a year its own triggers refuse to change. Each year is written in its
--     own block, so a refusal skips that year and the others are still
--     cleared.
--
-- Triggers that fire on the update. enforce_opening_balance_immutability
-- refuses a change of the pointer while opening_balances_set is true, so the
-- flag is cleared first and the pointer second, as delete_last_voucher does
-- for an IB it deletes. The close and lock guard, the fiscal year law check
-- and the start-day check see no change in what they guard. The audit
-- trigger records both updates.
--
-- Idempotent: a year whose pointer is NULL or names a standing verifikat
-- matches nothing. No table, column, constraint, index, function or policy
-- changes. One NOTICE says how many years were cleared and how many skipped.

DO $$
DECLARE
  v_period record;
  v_cleared integer := 0;
  v_skipped integer := 0;
BEGIN
  -- A row lock held by a running request is not waited for: the year is
  -- skipped by the handler below instead.
  PERFORM set_config('lock_timeout', '5s', true);

  FOR v_period IN
    SELECT fp.id
    FROM public.fiscal_periods fp
    JOIN public.journal_entries e ON e.id = fp.opening_balance_entry_id
    WHERE e.status IN ('cancelled', 'draft')
      AND NOT EXISTS (
        SELECT 1 FROM public.company_migration_resets m
        WHERE m.source_company_id = fp.company_id
      )
  LOOP
    BEGIN
      UPDATE public.fiscal_periods
      SET opening_balances_set = false
      WHERE id = v_period.id;

      UPDATE public.fiscal_periods
      SET opening_balance_entry_id = NULL
      WHERE id = v_period.id;

      v_cleared := v_cleared + 1;
    EXCEPTION WHEN OTHERS THEN
      -- The year's own triggers refused the change, or its lock was not
      -- granted: both updates of this year are undone and the rest go on.
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RAISE NOTICE 'opening balance pointers to a voided verifikat: cleared %, skipped %', v_cleared, v_skipped;
END;
$$;
