-- BFL 3 kap. as a floor under every door: a räkenskapsår is at most 18 months,
-- and an enskild firma's ends on 31 December with only the first starting
-- after 1 January. The doors say this in full, with their own codes
-- (checkPeriodDuration in lib/bookkeeping/validate-period-duration.ts, the
-- blockers in redate_fiscal_period); this refuses what reaches the table past
-- them, in the same count: a mid-month start takes its month in full.
--
-- It looks at a new year and at new dates only. A year already stored is never
-- re-judged, so an edit that leaves its dates alone goes through: prod holds
-- one year of 36 months and one enskild firma on broken years, and rows stay.

CREATE OR REPLACE FUNCTION public.enforce_fiscal_year_law()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_months integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.period_start = OLD.period_start
     AND NEW.period_end = OLD.period_end THEN
    RETURN NEW;
  END IF;

  v_months := (extract(year FROM NEW.period_end)::integer - extract(year FROM NEW.period_start)::integer) * 12
            + (extract(month FROM NEW.period_end)::integer - extract(month FROM NEW.period_start)::integer) + 1;
  IF v_months > 18 THEN
    RAISE EXCEPTION 'FISCAL_PERIOD_TOO_LONG: räkenskapsåret % till % är % månader, högst 18 (BFL 3 kap.)',
      NEW.period_start, NEW.period_end, v_months
      USING ERRCODE = 'check_violation';
  END IF;

  -- SECURITY DEFINER so RLS cannot hide the company and skip the rule.
  IF EXISTS (
    SELECT 1 FROM public.companies c
     WHERE c.id = NEW.company_id
       AND c.entity_type = 'enskild_firma'
  ) THEN
    IF to_char(NEW.period_end, 'MM-DD') <> '12-31' THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR: enskild firma måste ha slutdatum 31 december (BFL 3 kap.), inte %',
        NEW.period_end
        USING ERRCODE = 'check_violation';
    END IF;

    -- The first year is the one no recorded year starts before, as in
    -- enforce_first_of_month_for_subsequent_periods.
    IF to_char(NEW.period_start, 'MM-DD') <> '01-01' AND EXISTS (
      SELECT 1 FROM public.fiscal_periods o
       WHERE o.company_id = NEW.company_id
         AND o.id IS DISTINCT FROM NEW.id
         AND o.period_start < NEW.period_start
    ) THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR: bara det första räkenskapsåret får börja efter 1 januari (BFL 3 kap.), inte %',
        NEW.period_start
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_fiscal_year_law() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS enforce_fiscal_year_law ON public.fiscal_periods;
CREATE TRIGGER enforce_fiscal_year_law
  BEFORE INSERT OR UPDATE OF period_start, period_end ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.enforce_fiscal_year_law();

COMMENT ON FUNCTION public.enforce_fiscal_year_law() IS
  'BFL 3 kap. on a new year or new dates: at most 18 months, and the calendar year for an enskild firma. The doors check first (checkPeriodDuration); a stored year is never re-judged.';
