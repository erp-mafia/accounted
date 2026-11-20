-- =============================================================================
-- Budgets stay consistent when the year, the kontoplan or the dimension
-- registry changes (accounted#134, part 1)
--
-- 1. redate_fiscal_period refuses a re-date that would leave a budget month
--    outside the year, with a blocker naming the budget (budget_months_outside),
--    so the dry run and the staged preview show it too. The function is
--    restated from 20261015180500 with that one blocker added (section 4b);
--    signature, grants and every other rule are unchanged.
-- 2. guard_fiscal_period_redate_budgets on fiscal_periods: the same rule for
--    a direct UPDATE of period_start/period_end, the floor under the RPC (as
--    guard_fiscal_period_redate_entries is for verifikat, 20261024140200).
-- 3. Dimension retention covers budget lines: a dimension value a budget line
--    is tagged with, or a dimension a budget line uses, cannot be deleted;
--    the refusal names the budget and says to archive instead.
--    enforce_dimension_value_retention is restated from 20260702084500 and
--    enforce_dimension_registry_guards from 20260807130000, each with the
--    budget check added after the journal check. The sandbox teardown is
--    unaffected: it deletes the dimensions (the registry guard's teardown
--    window), and the values go with that cascade, where the value guard
--    finds no dimension and returns. Their Swedish messages lose the em dash
--    the old text carried; nothing matches on it (the routes pass the message
--    on verbatim).
--
--    Inside the destructive window (gnubok.allow_delete, set by
--    reset_fiscal_year and undo_sie_import while they remove the values and
--    dimensions an import created) a budget line does not stop the removal:
--    the line keeps its tag as text, as a journal line does, and the
--    re-import that usually follows brings the code back. Refusing there
--    would refuse the whole reset or undo.
-- 4. correct_company_entity_type refuses while a budget has amounts: the
--    correction deletes the seeded kontoplan, and budget_lines' account key
--    (ON DELETE CASCADE) would take every amount with it, silently. Restated
--    from 20261002200200 with budget_lines counted among the configured
--    references (ENTITY_TYPE_CHANGE_CONFIGURED_ACCOUNTS); nothing else
--    changes.
--
-- The kontoplan's own delete paths (one account, "Rensa oanvända konton")
-- read get_account_budget_line_counts (20261031121100) in the application.
-- No enforcement trigger is touched.
--
-- pg-test: tests/pg/budgets.pg.test.ts
-- =============================================================================

-- 1 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.redate_fiscal_period(
  p_company_id   uuid,
  p_period_id    uuid,
  p_period_start date,
  p_period_end   date,
  p_name         text    DEFAULT NULL,
  p_dry_run      boolean DEFAULT false,
  p_user_id      uuid    DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_end_user      boolean := public.jwt_caller_is_end_user()
                             OR coalesce(current_setting('role', true), '') IN ('anon', 'authenticated');
  v_actor         uuid;
  v_role          text;
  v_period        public.fiscal_periods%ROWTYPE;
  v_updated       public.fiscal_periods%ROWTYPE;
  v_entity_type   text;
  v_new_start     date;
  v_new_end       date;
  v_new_name      text;
  v_start_moves   boolean;
  v_end_moves     boolean;
  v_dates_move    boolean;
  v_start_fix     boolean;
  v_first_changed date;
  v_is_first      boolean;
  v_months        integer;
  v_blockers      jsonb := '[]'::jsonb;
  v_lock_through  date;
  v_count         integer;
  v_examples      text;
  v_first_date    date;
  v_last_date     date;
  v_other         record;
  v_label         text;
  v_filed         text;
BEGIN
  -- Actor resolution and role gate.
  IF v_end_user THEN
    v_actor := auth.uid();
  ELSE
    v_actor := COALESCE(p_user_id, auth.uid());
  END IF;

  SELECT cm.role INTO v_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_actor IS NULL OR v_role IS NULL OR v_role = 'viewer' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  -- Serialize against concurrent edits of the same year. FOR UPDATE also
  -- conflicts with the FOR KEY SHARE lock a journal_entries insert takes on
  -- its period, so no verifikat can land in the year between the checks
  -- below and the UPDATE. A dry run only reads.
  IF p_dry_run THEN
    SELECT * INTO v_period
      FROM public.fiscal_periods
     WHERE id = p_period_id
       AND company_id = p_company_id;
  ELSE
    SELECT * INTO v_period
      FROM public.fiscal_periods
     WHERE id = p_period_id
       AND company_id = p_company_id
       FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PERIOD_NOT_FOUND');
  END IF;

  v_new_start   := COALESCE(p_period_start, v_period.period_start);
  v_new_end     := COALESCE(p_period_end, v_period.period_end);
  v_new_name    := COALESCE(NULLIF(btrim(p_name), ''), v_period.name);
  v_start_moves := v_new_start <> v_period.period_start;
  v_end_moves   := v_new_end <> v_period.period_end;
  v_dates_move  := v_start_moves OR v_end_moves;

  -- The first-year start correction (crm#1140): only the start of the
  -- company's earliest räkenskapsår moves, within the calendar month it
  -- already starts in, and the name stays. Such a move reassigns nothing:
  -- no year precedes it, the days that change hands hold no verifikat or
  -- draft (checked below like any re-date), and every amount the bokslut
  -- computed in whole months (the 18-month count, överavskrivningar) is the
  -- same for every start inside one month. So the year's own close and lock,
  -- its closing verifikat and the company lock date do not block it: the
  -- year keeps is_closed, locked_at and its closing entry, and every day it
  -- holds afterwards is still behind the same locks (a day added at the
  -- start is earlier than the lock date, a day removed leaves every year and
  -- can hold nothing). What does depend on the exact start keeps blocking:
  -- posted opening balances, planned depreciation (computed in days), the
  -- kontantmetod cut-off, a tax depreciation election, a finalized annual
  -- report and anything filed for the year.
  v_start_fix := v_start_moves
    AND NOT v_end_moves
    AND v_new_name = v_period.name
    AND date_trunc('month', v_new_start::timestamp) = date_trunc('month', v_period.period_start::timestamp)
    AND NOT EXISTS (
      SELECT 1 FROM public.fiscal_periods o
       WHERE o.company_id = p_company_id
         AND o.id <> p_period_id
         AND o.period_start < LEAST(v_new_start, v_period.period_start)
    );

  -- 1. The year's own state.
  IF NOT v_start_fix
     AND (COALESCE(v_period.is_closed, false) OR v_period.closed_externally OR v_period.closing_entry_id IS NOT NULL) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'period_closed',
      'message_sv', 'Räkenskapsåret är stängt.'));
  END IF;
  IF NOT v_start_fix AND v_period.locked_at IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'period_locked',
      'message_sv', 'Räkenskapsåret är låst. Lås upp det först om datumen behöver rättas.'));
  END IF;
  IF v_period.import_hold IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'sie_import_hold',
      'message_sv', 'En SIE-import pågår i räkenskapsåret. Slutför eller ångra importen först.'));
  END IF;
  IF v_period.opening_balance_review_import_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'opening_balance_review',
      'message_sv', 'Ingående balanser från en SIE-import väntar på granskning. Granska dem först.'));
  END IF;

  IF v_dates_move AND v_new_end <= v_new_start THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'end_not_after_start',
      'message_sv', 'Slutdatumet måste ligga efter startdatumet.',
      'period_start', to_char(v_new_start, 'YYYY-MM-DD'),
      'period_end', to_char(v_new_end, 'YYYY-MM-DD')));
  ELSIF v_dates_move THEN
    -- 2. BFL 3 kap. shape of the new year.
    SELECT entity_type INTO v_entity_type FROM public.companies WHERE id = p_company_id;

    v_is_first := NOT EXISTS (
      SELECT 1 FROM public.fiscal_periods o
       WHERE o.company_id = p_company_id
         AND o.id <> p_period_id
         AND o.period_start < v_new_start
    );

    IF v_new_end <> (date_trunc('month', v_new_end::timestamp) + interval '1 month - 1 day')::date THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'end_not_month_end',
        'message_sv', 'Räkenskapsåret måste sluta på sista dagen i en månad (BFL 3 kap.).',
        'period_end', to_char(v_new_end, 'YYYY-MM-DD')));
    END IF;

    IF NOT v_is_first AND extract(day FROM v_new_start) <> 1 THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'start_not_first_of_month',
        'message_sv', 'Räkenskapsåret måste börja den 1:a i en månad. Bara företagets första räkenskapsår får börja mitt i en månad (BFL 3 kap. 1 och 3 §§).',
        'period_start', to_char(v_new_start, 'YYYY-MM-DD')));
    END IF;

    -- Same count as monthsBetween() in lib/bookkeeping/validate-period-duration.ts:
    -- a mid-month start counts its month in full.
    v_months := (extract(year FROM v_new_end)::integer - extract(year FROM v_new_start)::integer) * 12
              + (extract(month FROM v_new_end)::integer - extract(month FROM v_new_start)::integer) + 1;
    IF v_months > 18 THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'exceeds_18_months',
        'message_sv', format('Räkenskapsåret blir %s månader. Ett räkenskapsår får vara högst 18 månader (BFL 3 kap.).', v_months),
        'months', v_months,
        'max_months', 18));
    END IF;

    IF v_entity_type = 'enskild_firma' THEN
      IF extract(month FROM v_new_end) <> 12 OR extract(day FROM v_new_end) <> 31 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
          'code', 'enskild_firma_calendar_year',
          'message_sv', 'Enskild firma måste ha slutdatum 31 december enligt BFL 3 kap.',
          'period_end', to_char(v_new_end, 'YYYY-MM-DD')));
      ELSIF NOT v_is_first AND (extract(month FROM v_new_start) <> 1 OR extract(day FROM v_new_start) <> 1) THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
          'code', 'enskild_firma_calendar_year',
          'message_sv', 'Enskild firma måste använda kalenderår (1 januari till 31 december) enligt BFL 3 kap.',
          'period_start', to_char(v_new_start, 'YYYY-MM-DD')));
      END IF;
    END IF;

    -- 3. Neighbours: never overlap, stay contiguous (BFNAR 2013:2).
    SELECT o.id, o.name INTO v_other
      FROM public.fiscal_periods o
     WHERE o.company_id = p_company_id
       AND o.id <> p_period_id
       AND o.period_start <= v_new_end
       AND o.period_end >= v_new_start
     ORDER BY o.period_start
     LIMIT 1;
    IF FOUND THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'overlap',
        'message_sv', format('De nya datumen överlappar %s.', v_other.name),
        'overlapping_period_id', v_other.id,
        'overlapping_period_name', v_other.name));
    ELSE
      SELECT o.id, o.name, o.period_end INTO v_other
        FROM public.fiscal_periods o
       WHERE o.company_id = p_company_id
         AND o.id <> p_period_id
         AND o.period_end < v_new_start
       ORDER BY o.period_end DESC
       LIMIT 1;
      IF FOUND AND v_new_start <> v_other.period_end + 1 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
          'code', 'not_contiguous',
          'message_sv', format('Räkenskapsåret måste börja %s, dagen efter att %s slutar.',
                               to_char(v_other.period_end + 1, 'YYYY-MM-DD'), v_other.name),
          'expected_start', to_char(v_other.period_end + 1, 'YYYY-MM-DD'),
          'preceding_period_id', v_other.id));
      END IF;

      SELECT o.id, o.name, o.period_start INTO v_other
        FROM public.fiscal_periods o
       WHERE o.company_id = p_company_id
         AND o.id <> p_period_id
         AND o.period_start > v_new_end
       ORDER BY o.period_start
       LIMIT 1;
      IF FOUND AND v_new_end <> v_other.period_start - 1 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
          'code', 'not_contiguous',
          'message_sv', format('Räkenskapsåret måste sluta %s, dagen innan %s börjar.',
                               to_char(v_other.period_start - 1, 'YYYY-MM-DD'), v_other.name),
          'expected_end', to_char(v_other.period_start - 1, 'YYYY-MM-DD'),
          'following_period_id', v_other.id));
      END IF;
    END IF;

    -- 4. Verifikat: nothing booked may end up outside its year. Numbered
    -- verifikat (posted, reversed, or a cancelled orphan that kept its
    -- number) and drafts are counted apart: a draft can be re-dated or
    -- deleted, a verifikat only corrected.
    SELECT count(*),
           min(je.entry_date),
           max(je.entry_date),
           string_agg(format('%s%s (%s)', je.voucher_series, je.voucher_number, to_char(je.entry_date, 'YYYY-MM-DD')),
                      ', ' ORDER BY je.entry_date, je.voucher_series, je.voucher_number)
             FILTER (WHERE je.rn <= 5)
      INTO v_count, v_first_date, v_last_date, v_examples
      FROM (
        SELECT e.entry_date, e.voucher_series, e.voucher_number,
               row_number() OVER (ORDER BY e.entry_date, e.voucher_series, e.voucher_number) AS rn
          FROM public.journal_entries e
         WHERE e.company_id = p_company_id
           AND e.fiscal_period_id = p_period_id
           AND (e.status IN ('posted', 'reversed')
                OR (e.status = 'cancelled' AND COALESCE(e.voucher_number, 0) > 0))
           AND (e.entry_date < v_new_start OR e.entry_date > v_new_end)
      ) je;
    IF v_count > 0 THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'entries_outside',
        'message_sv', CASE WHEN v_count = 1
          THEN format('En bokförd verifikation ligger utanför de nya datumen: %s.', v_examples)
          ELSE format('%s bokförda verifikationer ligger utanför de nya datumen: %s%s.',
                      v_count, v_examples, CASE WHEN v_count > 5 THEN ' med flera' ELSE '' END)
        END,
        'count', v_count,
        'first_date', to_char(v_first_date, 'YYYY-MM-DD'),
        'last_date', to_char(v_last_date, 'YYYY-MM-DD')));
    END IF;

    SELECT count(*) INTO v_count
      FROM public.journal_entries e
     WHERE e.company_id = p_company_id
       AND e.fiscal_period_id = p_period_id
       AND e.status = 'draft'
       AND (e.entry_date < v_new_start OR e.entry_date > v_new_end);
    IF v_count > 0 THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'drafts_outside',
        'message_sv', CASE WHEN v_count = 1
          THEN 'Ett utkast ligger utanför de nya datumen. Ändra dess datum eller ta bort det först.'
          ELSE format('%s utkast ligger utanför de nya datumen. Ändra deras datum eller ta bort dem först.', v_count)
        END,
        'count', v_count));
    END IF;

    SELECT count(*) INTO v_count
      FROM public.journal_entries e
     WHERE e.company_id = p_company_id
       AND e.fiscal_period_id <> p_period_id
       AND e.status <> 'cancelled'
       AND e.entry_date BETWEEN v_new_start AND v_new_end;
    IF v_count > 0 THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'other_year_entries',
        'message_sv', CASE WHEN v_count = 1
          THEN 'En verifikation i ett annat räkenskapsår ligger inom de nya datumen.'
          ELSE format('%s verifikationer i ett annat räkenskapsår ligger inom de nya datumen.', v_count)
        END,
        'count', v_count));
    END IF;

    -- 4b. Budgets (accounted#134): every budget month stays inside the
    -- year, the start month in full. The budget is named, so the user knows
    -- which months to remove first.
    SELECT count(DISTINCT b.id),
           string_agg(DISTINCT format('"%s"', b.name), ', ')
      INTO v_count, v_examples
      FROM public.budgets b
      JOIN public.budget_lines bl ON bl.budget_id = b.id
     WHERE b.company_id = p_company_id
       AND b.fiscal_period_id = p_period_id
       AND (bl.month < date_trunc('month', v_new_start::timestamp)::date OR bl.month > v_new_end);
    IF v_count > 0 THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'budget_months_outside',
        'message_sv', CASE WHEN v_count = 1
          THEN format('Budgeten %s har belopp för månader utanför de nya datumen. Ta bort de månaderna ur budgeten först.', v_examples)
          ELSE format('Budgetarna %s har belopp för månader utanför de nya datumen. Ta bort de månaderna ur budgetarna först.', v_examples)
        END,
        'count', v_count));
    END IF;

    -- 5. Opening balances open the year on its first day: the start cannot
    -- move away from posted ones.
    IF v_start_moves THEN
      SELECT count(*),
             string_agg(format('%s%s (%s)', e.voucher_series, e.voucher_number, to_char(e.entry_date, 'YYYY-MM-DD')),
                        ', ' ORDER BY e.entry_date, e.voucher_series, e.voucher_number)
        INTO v_count, v_examples
        FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
         AND e.status = 'posted'
         AND (e.source_type = 'opening_balance' OR e.id = v_period.opening_balance_entry_id);
      IF v_count > 0 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
          'code', 'opening_balance',
          'message_sv', format('Räkenskapsåret har bokförda ingående balanser (%s). Startdatumet kan inte flyttas så länge de finns.', v_examples),
          'count', v_count));
      END IF;
    END IF;

    -- 6. The company lock date may not reach any day that changes hands.
    v_first_changed := CASE
      WHEN v_start_moves THEN LEAST(v_new_start, v_period.period_start)
      ELSE LEAST(v_new_end, v_period.period_end) + 1
    END;
    SELECT cs.bookkeeping_locked_through INTO v_lock_through
      FROM public.company_settings cs
     WHERE cs.company_id = p_company_id;
    IF NOT v_start_fix AND v_lock_through IS NOT NULL AND v_lock_through >= v_first_changed THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'company_lock_date',
        'message_sv', format('Bokföringen är låst t.o.m. %s och ändringen rör dagar i den låsta delen. Flytta låsdatumet först.',
                             to_char(v_lock_through, 'YYYY-MM-DD')),
        'locked_through', to_char(v_lock_through, 'YYYY-MM-DD')));
    END IF;

    -- 7. Year-end work computed on the current dates. The first-year start
    -- correction leaves the closing verifikat valid (see v_start_fix); the
    -- year-end work that reads the start keeps blocking below.
    IF NOT v_start_fix AND EXISTS (
      SELECT 1 FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
         AND e.source_type = 'year_end'
         AND e.status = 'posted'
    ) THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'year_end_entries',
        'message_sv', 'Räkenskapsåret har ett bokfört bokslut. Återför bokslutet först.'));
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.kontantmetod_cutoff_entries k
        JOIN public.journal_entries e ON e.id = k.journal_entry_id
       WHERE k.company_id = p_company_id
         AND k.fiscal_period_id = p_period_id
         AND e.status = 'posted'
    ) THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'kontantmetod_cutoff',
        'message_sv', 'Bokslutsposter för kontantmetoden är bokförda för räkenskapsåret. Återför dem först.'));
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.depreciation_schedules d
        JOIN public.journal_entries e ON e.id = d.journal_entry_id
       WHERE d.company_id = p_company_id
         AND d.fiscal_period_id = p_period_id
         AND e.status = 'posted'
    ) THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'depreciation_posted',
        'message_sv', 'Årets avskrivningar är bokförda och beräknade på de nuvarande datumen. Återför dem först.'));
    END IF;
    IF v_period.tax_depreciation_method IS NOT NULL THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'tax_depreciation',
        'message_sv', 'En skattemässig avskrivning är vald för räkenskapsåret och beräknad på de nuvarande datumen.'));
    END IF;

    -- 8. Filings that state the year's dates.
    SELECT (SELECT count(*) FROM public.annual_report_versions v
             WHERE v.company_id = p_company_id
               AND v.fiscal_period_id = p_period_id
               AND v.status IN ('ready_for_signature', 'signed', 'filed', 'registered'))
         + (SELECT count(*) FROM public.arsredovisning_signature_requests s
             WHERE s.company_id = p_company_id
               AND s.fiscal_period_id = p_period_id
               AND s.status = 'signed')
         + (SELECT count(*) FROM public.arsredovisning_submissions s
             WHERE s.company_id = p_company_id
               AND s.fiscal_period_id = p_period_id
               AND s.status NOT IN ('draft', 'kontrollerad', 'error'))
      INTO v_count;
    IF v_count > 0 THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'annual_report',
        'message_sv', 'Årsredovisningen för räkenskapsåret är färdigställd, signerad eller inskickad med de nuvarande datumen.'));
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.tax_assessment_notices t
       WHERE t.company_id = p_company_id
         AND t.fiscal_period_id = p_period_id
    ) THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'tax_assessment',
        'message_sv', 'Ett beslut om slutlig skatt är registrerat för räkenskapsåret.'));
    END IF;

    -- Annual deadlines carry the year's label (getFiscalYearLabel in
    -- lib/tax/deadline-config.ts): "2026" for a calendar year, "2025/2026"
    -- for a broken one. A filed one (submitted by hand or confirmed at
    -- Skatteverket) was declared on the current dates.
    v_label := CASE
      WHEN extract(month FROM v_period.period_end) = 12 THEN extract(year FROM v_period.period_end)::integer::text
      ELSE (extract(year FROM v_period.period_end)::integer - 1)::text || '/' || extract(year FROM v_period.period_end)::integer::text
    END;
    SELECT string_agg(DISTINCT CASE
             WHEN d.tax_deadline_type = 'moms_yearly' THEN 'momsdeklaration för helår'
             WHEN d.tax_deadline_type LIKE 'inkomstdeklaration%' THEN 'inkomstdeklaration'
             ELSE 'årsredovisning'
           END, ', ')
      INTO v_filed
      FROM public.deadlines d
     WHERE d.company_id = p_company_id
       AND d.tax_period = v_label
       AND d.status IN ('submitted', 'confirmed')
       AND d.tax_deadline_type IN ('moms_yearly', 'inkomstdeklaration_ab', 'inkomstdeklaration_ef',
                                   'inkomstdeklaration_ekonomisk_forening',
                                   'inkomstdeklaration_ideell_forening', 'arsredovisning',
                                   'arsredovisning_ekonomisk_forening');
    IF v_filed IS NOT NULL THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'annual_filing',
        'message_sv', format('Följande är redan inlämnat för räkenskapsåret: %s.', v_filed),
        'tax_period', v_label));
    END IF;
  END IF;

  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FISCAL_PERIOD_DATES_BLOCKED',
      'blockers', v_blockers,
      'period', jsonb_build_object(
        'id', v_period.id,
        'name', v_period.name,
        'period_start', to_char(v_period.period_start, 'YYYY-MM-DD'),
        'period_end', to_char(v_period.period_end, 'YYYY-MM-DD')),
      'requested', jsonb_build_object(
        'period_start', to_char(v_new_start, 'YYYY-MM-DD'),
        'period_end', to_char(v_new_end, 'YYYY-MM-DD')));
  END IF;

  IF NOT v_dates_move AND v_new_name = v_period.name THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'dry_run', p_dry_run, 'period', to_jsonb(v_period));
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true,
      'changed', true,
      'dry_run', true,
      'period', to_jsonb(v_period),
      'requested', jsonb_build_object(
        'name', v_new_name,
        'period_start', to_char(v_new_start, 'YYYY-MM-DD'),
        'period_end', to_char(v_new_end, 'YYYY-MM-DD')));
  END IF;

  BEGIN
    UPDATE public.fiscal_periods
       SET period_start = v_new_start,
           period_end   = v_new_end,
           name         = v_new_name
     WHERE id = p_period_id
       AND company_id = p_company_id
    RETURNING * INTO v_updated;
  EXCEPTION WHEN exclusion_violation THEN
    -- A concurrent create won the race past the overlap read above.
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FISCAL_PERIOD_DATES_BLOCKED',
      'blockers', jsonb_build_array(jsonb_build_object(
        'code', 'overlap',
        'message_sv', 'De nya datumen överlappar ett annat räkenskapsår.')));
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'dry_run', false,
    'period', to_jsonb(v_updated),
    'previous', jsonb_build_object(
      'name', v_period.name,
      'period_start', to_char(v_period.period_start, 'YYYY-MM-DD'),
      'period_end', to_char(v_period.period_end, 'YYYY-MM-DD')));
END;
$function$;

REVOKE ALL ON FUNCTION public.redate_fiscal_period(uuid, uuid, date, date, text, boolean, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redate_fiscal_period(uuid, uuid, date, date, text, boolean, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.redate_fiscal_period(uuid, uuid, date, date, text, boolean, uuid) IS
  'Move the start and/or end of an open räkenskapsår, also one that holds verifikat, refusing (FISCAL_PERIOD_DATES_BLOCKED with Swedish blockers) whenever a verifikat, opening balance, budget month, lock, closing, filing or SIE hold would be affected. The start of the earliest year may also be corrected within its month when the year is closed or locked (crm#1140). p_dry_run answers without writing. p_user_id is honored only for service-role callers. crm#1010.';


-- 2 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_fiscal_period_redate_budgets()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_names text;
BEGIN
  IF NEW.period_start IS NOT DISTINCT FROM OLD.period_start
     AND NEW.period_end IS NOT DISTINCT FROM OLD.period_end THEN
    RETURN NEW;
  END IF;

  -- Serialise with every write of the year's budget lines: a grid save holds
  -- its budget FOR UPDATE and a line insert takes FOR KEY SHARE on it
  -- (enforce_budget_line_month), so a line committed while this re-date runs
  -- is waited for and read below, never left outside the new dates.
  PERFORM 1 FROM public.budgets WHERE fiscal_period_id = NEW.id FOR UPDATE;

  SELECT string_agg(DISTINCT format('"%s"', b.name), ', ')
    INTO v_names
    FROM public.budgets b
    JOIN public.budget_lines bl ON bl.budget_id = b.id
   WHERE b.fiscal_period_id = NEW.id
     AND (bl.month < date_trunc('month', NEW.period_start::timestamp)::date OR bl.month > NEW.period_end);

  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'Budget % har belopp för månader utanför räkenskapsåret % till %. Ta bort de månaderna ur budgeten först.',
      v_names, NEW.period_start, NEW.period_end
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_fiscal_period_redate_budgets() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS guard_fiscal_period_redate_budgets ON public.fiscal_periods;
CREATE TRIGGER guard_fiscal_period_redate_budgets
  BEFORE UPDATE OF period_start, period_end ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_period_redate_budgets();

COMMENT ON FUNCTION public.guard_fiscal_period_redate_budgets() IS
  'New fiscal period dates may not leave a budget month outside the year (redate_fiscal_period checks first; this guards a direct UPDATE). accounted#134.';

-- 3 ---------------------------------------------------------------------------

-- A code referenced by a posted/reversed line, or by a budget line, cannot
-- be deleted: archive it instead. Fires on a direct DELETE and on the cascade
-- from dimensions.
CREATE OR REPLACE FUNCTION public.enforce_dimension_value_retention()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dim_no int;
  v_budget text;
BEGIN
  SELECT d.sie_dim_no INTO v_dim_no
  FROM public.dimensions d
  WHERE d.id = OLD.dimension_id;

  IF v_dim_no IS NULL THEN
    -- Parent dimension row already gone (same-statement cascade edge): the
    -- registry guard checked the dimension's number before it went. This is
    -- also how the sandbox teardown reaches values (DELETE FROM dimensions),
    -- so its demo budget lines never block it.
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.company_id = OLD.company_id
      AND je.status IN ('posted', 'reversed')
      AND jel.dimensions ->> v_dim_no::text = OLD.code
  ) THEN
    RAISE EXCEPTION 'Värdet "%" används på bokförda verifikat och kan inte tas bort: arkivera det istället.',
      OLD.code;
  END IF;

  -- A budget line keeps its tag as text, like a journal line. Inside the
  -- destructive window (gnubok.allow_delete: reset_fiscal_year and
  -- undo_sie_import removing the values an import created) the budget does
  -- not stop the removal: the tag stays on the line, and the re-import that
  -- usually follows creates the same code again.
  IF coalesce(current_setting('gnubok.allow_delete', true), '') <> 'true' THEN
    SELECT b.name INTO v_budget
    FROM public.budget_lines bl
    JOIN public.budgets b ON b.id = bl.budget_id
    WHERE bl.company_id = OLD.company_id
      AND bl.dimensions ->> v_dim_no::text = OLD.code
    ORDER BY b.name
    LIMIT 1;
  END IF;
  IF v_budget IS NOT NULL THEN
    RAISE EXCEPTION 'Värdet "%" används i budgeten "%" och kan inte tas bort: arkivera det istället.',
      OLD.code, v_budget;
  END IF;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.enforce_dimension_value_retention() IS
  'A dimension value tagged on a posted/reversed journal line or on a budget line cannot be deleted (archive it instead).';

CREATE OR REPLACE FUNCTION public.enforce_dimension_registry_guards()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_budget text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sie_dim_no <> OLD.sie_dim_no THEN
      RAISE EXCEPTION 'Dimensionsnumret kan inte ändras (rader är taggade med numret).';
    END IF;
    IF NEW.is_system <> OLD.is_system THEN
      RAISE EXCEPTION 'is_system kan inte ändras.';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE
  -- Sandbox teardown deletes the entire company; its registry rows go with
  -- it. Transaction-local flag, only set by cleanup_sandbox_user after its
  -- is_sandbox check, plus a per-row re-verification (same pattern as
  -- audit_log_immutable) so the flag alone can never unlock a real
  -- company's registry. cleanup_sandbox_user deletes these rows explicitly
  -- while company_settings still exists; the re-check would fail mid-cascade
  -- once that row is gone.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;
  IF OLD.is_system THEN
    RAISE EXCEPTION 'Systemdimensionen % (%) kan inte tas bort: avaktivera den istället.',
      OLD.sie_dim_no, OLD.name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.company_id = OLD.company_id
      AND je.status IN ('posted', 'reversed')
      AND jel.dimensions ? OLD.sie_dim_no::text
  ) THEN
    RAISE EXCEPTION 'Dimensionen % (%) används på bokförda verifikat och kan inte tas bort: avaktivera den istället.',
      OLD.sie_dim_no, OLD.name;
  END IF;
  -- Same destructive window as enforce_dimension_value_retention.
  IF coalesce(current_setting('gnubok.allow_delete', true), '') <> 'true' THEN
    SELECT b.name INTO v_budget
    FROM public.budget_lines bl
    JOIN public.budgets b ON b.id = bl.budget_id
    WHERE bl.company_id = OLD.company_id
      AND bl.dimensions ? OLD.sie_dim_no::text
    ORDER BY b.name
    LIMIT 1;
  END IF;
  IF v_budget IS NOT NULL THEN
    RAISE EXCEPTION 'Dimensionen % (%) används i budgeten "%" och kan inte tas bort: avaktivera den istället.',
      OLD.sie_dim_no, OLD.name, v_budget;
  END IF;
  RETURN OLD;
END;
$$;

-- 4 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.correct_company_entity_type(
  p_company_id uuid,
  p_entity_type text,
  -- Optional framework the company holds after the correction, written in
  -- the same transaction so no reader sees a form paired with a framework it
  -- cannot carry (the route validates the resulting pair). NULL keeps it.
  p_accounting_framework text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor            uuid := auth.uid();
  v_role             text;
  v_company          public.companies%ROWTYPE;
  v_entry_count      integer;
  v_invoice_count    integer;
  v_supplier_count   integer;
  v_custom_accounts  integer;
  v_configured_refs  integer;
  v_removed_accounts integer;
  v_entries_after    integer;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_FORBIDDEN');
  END IF;

  IF p_entity_type IS NULL OR NOT (p_entity_type = ANY (public.supported_entity_types())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_UNSUPPORTED');
  END IF;

  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = p_company_id
    AND user_id = v_actor;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_NOT_FOUND');
  END IF;

  IF v_role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_FORBIDDEN');
  END IF;

  SELECT * INTO v_company
  FROM public.companies
  WHERE id = p_company_id
  FOR UPDATE;

  IF NOT FOUND OR v_company.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_NOT_FOUND');
  END IF;

  IF v_company.entity_type = p_entity_type THEN
    IF p_accounting_framework IS NOT NULL THEN
      UPDATE public.companies
      SET accounting_framework = p_accounting_framework
      WHERE id = p_company_id;
    END IF;
    RETURN jsonb_build_object('ok', true, 'changed', false, 'entity_type', p_entity_type);
  END IF;

  -- Serialise corrections of the same company and prove the books are
  -- empty. A single verifikat of any status makes the company ineligible.
  PERFORM pg_advisory_xact_lock(hashtextextended('correct_company_entity_type:' || p_company_id::text, 0));
  PERFORM 1 FROM public.chart_of_accounts WHERE company_id = p_company_id FOR UPDATE;

  SELECT count(*) INTO v_entry_count FROM public.journal_entries WHERE company_id = p_company_id;
  SELECT count(*) INTO v_invoice_count FROM public.invoices WHERE company_id = p_company_id;
  SELECT count(*) INTO v_supplier_count FROM public.supplier_invoices WHERE company_id = p_company_id;
  IF v_entry_count > 0 OR v_invoice_count > 0 OR v_supplier_count > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ENTITY_TYPE_CHANGE_BOOKS_NOT_EMPTY',
      'journal_entries', v_entry_count,
      'invoices', v_invoice_count,
      'supplier_invoices', v_supplier_count
    );
  END IF;

  SELECT count(*) INTO v_custom_accounts
  FROM public.chart_of_accounts
  WHERE company_id = p_company_id
    AND is_system_account IS DISTINCT FROM true;
  IF v_custom_accounts > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ENTITY_TYPE_CHANGE_CUSTOM_ACCOUNTS',
      'custom_accounts', v_custom_accounts
    );
  END IF;

  SELECT
    (SELECT count(*) FROM public.mapping_rules WHERE company_id = p_company_id)
    + (SELECT count(*) FROM public.account_dimension_rules WHERE company_id = p_company_id)
    + (SELECT count(*) FROM public.categorization_templates WHERE company_id = p_company_id)
    -- Budget amounts name accounts of the chart this replaces (accounted#134).
    + (SELECT count(*) FROM public.budget_lines WHERE company_id = p_company_id)
  INTO v_configured_refs;
  IF v_configured_refs > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ENTITY_TYPE_CHANGE_CONFIGURED_ACCOUNTS',
      'configured_references', v_configured_refs
    );
  END IF;

  DELETE FROM public.chart_of_accounts WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_removed_accounts = ROW_COUNT;

  -- Second look after the delete: a verifikat committed since the first
  -- count would reference accounts that no longer exist.
  SELECT count(*) INTO v_entries_after FROM public.journal_entries WHERE company_id = p_company_id;
  IF v_entries_after > 0 THEN
    RAISE EXCEPTION 'correct_company_entity_type: a journal entry was posted during the correction'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.companies
  SET entity_type = p_entity_type,
      accounting_framework = COALESCE(p_accounting_framework, accounting_framework)
  WHERE id = p_company_id;

  UPDATE public.company_settings
  SET entity_type = p_entity_type
  WHERE company_id = p_company_id;

  PERFORM public.seed_chart_of_accounts(p_company_id, p_entity_type);

  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    new_state,
    description
  ) VALUES (
    v_actor,
    p_company_id,
    'UPDATE',
    'companies',
    p_company_id,
    v_actor,
    jsonb_build_object(
      'entity_type', v_company.entity_type,
      'accounting_framework', v_company.accounting_framework
    ),
    jsonb_build_object(
      'entity_type', p_entity_type,
      'accounting_framework', COALESCE(p_accounting_framework, v_company.accounting_framework),
      'replaced_system_accounts', v_removed_accounts
    ),
    'Legal form corrected by the owner while the books were empty; seeded chart replaced'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'entity_type', p_entity_type,
    'previous_entity_type', v_company.entity_type,
    'replaced_system_accounts', v_removed_accounts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.correct_company_entity_type(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_company_entity_type(uuid, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
