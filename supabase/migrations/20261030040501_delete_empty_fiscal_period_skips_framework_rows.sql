-- delete_empty_fiscal_period_preview: the framework row K3 seeds with every
-- räkenskapsår does not make a year "linked".
--
-- 20261028030547 refuses to remove a first year while any table referencing
-- fiscal_periods holds a row for it. 20261030040201 (the K2/K3 framework per
-- räkenskapsår) seeds a fiscal_period_frameworks row for every year and
-- removes it with the year (ON DELETE CASCADE), so without this every empty
-- first year would count as holding records and could never be removed.
-- The function body is 20261028030547's, word for word, with that one table
-- added to the excluded list; grants as there. delete_empty_fiscal_period
-- itself calls this preview and is unchanged.
--
-- pg-test: tests/pg/delete-empty-fiscal-period.pg.test.ts

CREATE OR REPLACE FUNCTION public.delete_empty_fiscal_period_preview(
  p_company_id uuid,
  p_period_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_end_user     boolean := public.jwt_caller_is_end_user()
                            OR coalesce(current_setting('role', true), '') IN ('anon', 'authenticated');
  v_actor        uuid;
  v_role         text;
  v_period       public.fiscal_periods%ROWTYPE;
  v_blockers     jsonb := '[]'::jsonb;
  v_count        integer;
  v_lock_through date;
  v_fk           record;
  v_found        boolean;
  v_linked       text[] := ARRAY[]::text[];
  v_label        text;
  v_filed        text;
BEGIN
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

  SELECT * INTO v_period
    FROM public.fiscal_periods
   WHERE id = p_period_id
     AND company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PERIOD_NOT_FOUND');
  END IF;

  -- 1. Only the first year, and never the only one.
  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods o
     WHERE o.company_id = p_company_id
       AND o.id <> p_period_id
       AND o.period_start < v_period.period_start
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'not_first_year',
      'message_sv', 'Bara företagets första räkenskapsår kan tas bort.'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods o
     WHERE o.company_id = p_company_id
       AND o.id <> p_period_id
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'only_year',
      'message_sv', 'Företaget måste ha minst ett räkenskapsår.'));
  END IF;

  -- 2. The year's own state.
  IF COALESCE(v_period.is_closed, false) OR v_period.closed_externally OR v_period.closing_entry_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'period_closed',
      'message_sv', 'Räkenskapsåret är stängt.'));
  END IF;
  IF v_period.locked_at IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'period_locked',
      'message_sv', 'Räkenskapsåret är låst. Lås upp det först.'));
  END IF;
  IF v_period.import_hold IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'sie_import_hold',
      'message_sv', 'En SIE-import pågår i räkenskapsåret. Slutför eller ångra importen först.'));
  END IF;
  IF v_period.opening_balance_review_import_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'opening_balance_review',
      'message_sv', 'Ingående balanser från en SIE-import väntar på granskning.'));
  END IF;
  SELECT cs.bookkeeping_locked_through INTO v_lock_through
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;
  IF v_lock_through IS NOT NULL AND v_lock_through >= v_period.period_start THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'company_lock_date',
      'message_sv', format('Bokföringen är låst t.o.m. %s och låset täcker räkenskapsåret.',
                           to_char(v_lock_through, 'YYYY-MM-DD')),
      'locked_through', to_char(v_lock_through, 'YYYY-MM-DD')));
  END IF;

  -- 3. Nothing booked, drafted or numbered.
  SELECT count(*) INTO v_count
    FROM public.journal_entries e
   WHERE e.fiscal_period_id = p_period_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'has_entries',
      'message_sv', CASE WHEN v_count = 1
        THEN 'Räkenskapsåret har en verifikation eller ett utkast. Bara ett tomt räkenskapsår kan tas bort.'
        ELSE format('Räkenskapsåret har %s verifikationer eller utkast. Bara ett tomt räkenskapsår kan tas bort.', v_count)
      END,
      'count', v_count));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.voucher_sequences v
     WHERE v.fiscal_period_id = p_period_id
       AND v.last_number > 0
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'voucher_numbers_issued',
      'message_sv', 'Verifikationsnummer har redan delats ut i räkenskapsåret.'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports s WHERE s.fiscal_period_id = p_period_id) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'sie_import',
      'message_sv', 'En SIE-import hör till räkenskapsåret i importhistoriken.'));
  END IF;

  -- 4. Every other row that points at the year, read from the catalog.
  -- journal_entries, voucher_sequences and sie_imports are checked above;
  -- fiscal_periods.previous_period_id is the chain, cleared below.
  FOR v_fk IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.fiscal_periods'::regclass
       AND c.conrelid NOT IN ('public.journal_entries'::regclass,
                              'public.voucher_sequences'::regclass,
                              'public.sie_imports'::regclass,
                              'public.fiscal_periods'::regclass,
                              -- Seeded with every year (20261030040201) and
                              -- removed with it (ON DELETE CASCADE): the
                              -- year's framework, not something it holds.
                              'public.fiscal_period_frameworks'::regclass)
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', v_fk.tbl, v_fk.col)
      INTO v_found
      USING p_period_id;
    IF v_found THEN
      v_linked := v_linked || v_fk.tbl::text;
    END IF;
  END LOOP;
  IF cardinality(v_linked) > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'linked_records',
      'message_sv', format('Räkenskapsåret har kopplade uppgifter (%s).', array_to_string(v_linked, ', ')),
      'tables', to_jsonb(v_linked)));
  END IF;

  -- 5. A filed annual return for the year's label (getFiscalYearLabel).
  v_label := CASE
    WHEN extract(month FROM v_period.period_end) = 12 THEN extract(year FROM v_period.period_end)::integer::text
    ELSE (extract(year FROM v_period.period_end)::integer - 1)::text || '/' || extract(year FROM v_period.period_end)::integer::text
  END;
  SELECT string_agg(DISTINCT d.tax_deadline_type, ', ')
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
      'message_sv', 'En deklaration eller årsredovisning för räkenskapsåret är redan inlämnad.',
      'tax_period', v_label));
  END IF;

  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FISCAL_PERIOD_DELETE_BLOCKED',
      'blockers', v_blockers,
      'period', jsonb_build_object(
        'id', v_period.id,
        'name', v_period.name,
        'period_start', to_char(v_period.period_start, 'YYYY-MM-DD'),
        'period_end', to_char(v_period.period_end, 'YYYY-MM-DD')));
  END IF;

  RETURN jsonb_build_object('ok', true, 'period', to_jsonb(v_period));
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_empty_fiscal_period_preview(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_empty_fiscal_period_preview(uuid, uuid, uuid)
  TO authenticated, service_role;
