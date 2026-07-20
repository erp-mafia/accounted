-- Allow detaching or replacing a period's closing_entry_id ONLY when the
-- previously referenced closing entry has been genuinely reversed by storno.
--
-- Background: the administrative year-end undo flow (scripts/
-- undo-year-end-closing.ts) reverses the bokslutsverifikation with a storno
-- (BFL 5 kap 5 §: never edit, never delete) and must then clear
-- closing_entry_id so the year-end wizard can be re-run. The previous rule
-- blocked ANY change to closing_entry_id once set, which made an executed
-- bokslut unrecoverable even before an arsredovisning exists.
--
-- The invariant that matters is preserved and tightened:
--   * a period can never abandon a LIVE (posted) closing entry;
--   * the status='reversed' flag alone is not trusted (it is reachable via a
--     direct PostgREST update by a writer-role member): the actual storno
--     chain that only the engine's reverseEntry() produces must exist
--     (a posted source_type='storno' entry with reverses_id pointing at the
--     old closing entry);
--   * a non-NULL replacement must be a posted year_end entry in the same
--     company and period (what executeYearEndClosing sets on a re-run).
--
-- The opening-balance clause is unchanged.

CREATE OR REPLACE FUNCTION public.enforce_opening_balance_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only check if opening_balance_entry_id is being changed
  IF OLD.opening_balance_entry_id IS NOT NULL
     AND OLD.opening_balances_set = true
     AND NEW.opening_balance_entry_id IS DISTINCT FROM OLD.opening_balance_entry_id THEN
    RAISE EXCEPTION 'Cannot modify opening_balance_entry_id on period "%" — opening balances are immutable once set',
      OLD.name;
  END IF;

  -- Block changing closing_entry_id once set, UNLESS the referenced closing
  -- entry has been reversed by a real storno (administrative year-end undo).
  IF OLD.closing_entry_id IS NOT NULL
     AND NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id THEN

    IF NOT EXISTS (
      SELECT 1
      FROM journal_entries je
      JOIN journal_entries storno
        ON storno.reverses_id = je.id
       AND storno.source_type = 'storno'
       AND storno.status = 'posted'
       AND storno.company_id = OLD.company_id
      WHERE je.id = OLD.closing_entry_id
        AND je.company_id = OLD.company_id
        AND je.status = 'reversed'
    ) THEN
      RAISE EXCEPTION 'Cannot modify closing_entry_id on period "%": year-end closing is immutable',
        OLD.name;
    END IF;

    IF NEW.closing_entry_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM journal_entries ne
      WHERE ne.id = NEW.closing_entry_id
        AND ne.company_id = NEW.company_id
        AND ne.fiscal_period_id = NEW.id
        AND ne.source_type = 'year_end'
        AND ne.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'closing_entry_id on period "%" must reference a posted year_end entry in the same period',
        OLD.name;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
