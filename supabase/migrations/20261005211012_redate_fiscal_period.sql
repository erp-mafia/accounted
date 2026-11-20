-- Re-date a räkenskapsår that already holds verifikat (crm#1010).
--
-- A company whose first fiscal year was recorded one day late (2025-04-24
-- instead of Bolagsverket's 2025-04-23) had no supported way to correct it:
-- the edit path refused any date change once a single verifikat was posted
-- in the year (FISCAL_PERIOD_HAS_POSTED_ENTRIES, an application-only rule).
-- That rule protected the right thing (booked history must never be
-- reassigned to another year) with the wrong test: moving a boundary over
-- days that hold nothing reassigns nothing.
--
-- redate_fiscal_period is the guarded way to move a year's start and/or end.
-- It changes only the fiscal_periods row: no verifikat, line, voucher number
-- or document is touched, and no trigger is weakened or bypassed (the
-- enforce_period_start_day trigger, the month-end CHECK and the
-- no_overlapping_fiscal_periods exclusion constraint all still run on the
-- UPDATE, and write_audit_log records the old and new dates, which the
-- behandlingshistorik reports as "Räkenskapsår ändrat").
--
-- It refuses, naming each blocker in Swedish, whenever:
--   * the year is closed (is_closed, closed_externally, closing_entry_id) or
--     locked (locked_at);
--   * an SIE import holds the year (import_hold) or its opening balances
--     wait for review (opening_balance_review_import_id);
--   * a posted, reversed or numbered verifikat, or a draft, of the year
--     would fall outside the new dates, or a verifikat of another year
--     lies inside them;
--   * the start moves while the year has posted opening balances (they
--     open the year on its first day);
--   * the company lock date (bookkeeping_locked_through) reaches any day
--     that changes hands;
--   * year-end work computed on the current dates exists: a posted closing
--     entry, kontantmetod cut-off entries, posted depreciation for the year,
--     or a tax depreciation election;
--   * something was filed for the year: a finalized, signed or submitted
--     annual report, a tax assessment notice, or an annual declaration
--     (helårsmoms, inkomstdeklaration, årsredovisning) marked as filed;
--   * the new dates break BFL 3 kap. (end on a month end, at most 18 months,
--     only the earliest year may start mid-month, an enskild firma keeps the
--     calendar year) or the continuity chain (BFNAR 2013:2: no overlap, the
--     year still starts the day after its predecessor and ends the day before
--     its successor).
--
-- p_dry_run answers the same verdict without writing (the MCP staging
-- preview), so preview and execution cannot drift.
--
-- Actor gate (same shape as correct_entry_metadata): an end-user JWT acts as
-- auth.uid() and p_user_id is ignored; p_user_id names the actor only for
-- service-role callers (the v1 API and MCP doors, which authenticate the user
-- application-side). The actor must be a writing member of the company (any
-- role but viewer), the same rule as the fiscal_periods UPDATE policy.

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

  -- 1. The year's own state.
  IF COALESCE(v_period.is_closed, false) OR v_period.closed_externally OR v_period.closing_entry_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'period_closed',
      'message_sv', 'Räkenskapsåret är stängt.'));
  END IF;
  IF v_period.locked_at IS NOT NULL THEN
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
    IF v_lock_through IS NOT NULL AND v_lock_through >= v_first_changed THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'company_lock_date',
        'message_sv', format('Bokföringen är låst t.o.m. %s och ändringen rör dagar i den låsta delen. Flytta låsdatumet först.',
                             to_char(v_lock_through, 'YYYY-MM-DD')),
        'locked_through', to_char(v_lock_through, 'YYYY-MM-DD')));
    END IF;

    -- 7. Year-end work computed on the current dates.
    IF EXISTS (
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
                                   'inkomstdeklaration_ekonomisk_forening', 'arsredovisning',
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
  'Move the start and/or end of an open räkenskapsår, also one that holds verifikat, refusing (FISCAL_PERIOD_DATES_BLOCKED with Swedish blockers) whenever a verifikat, opening balance, lock, closing, filing or SIE hold would be affected. p_dry_run answers without writing. p_user_id is honored only for service-role callers. crm#1010.';

NOTIFY pgrst, 'reload schema';
