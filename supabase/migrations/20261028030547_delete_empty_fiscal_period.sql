-- Remove an empty first räkenskapsår (crm#1450).
--
-- Older onboarding rounded a company's start to the 1st of the month and
-- could seed a whole räkenskapsår before the company existed (crm#1140 fixed
-- the seeding for new companies only). Such a year blocks every repair of the
-- real first year: it is still "the earliest year", so the real first year
-- may not start mid-month on the registration day, and nothing could remove
-- it.
--
-- 1. delete_empty_fiscal_period removes the company's EARLIEST räkenskapsår
-- when it holds nothing at all, and refuses (FISCAL_PERIOD_DELETE_BLOCKED with
-- Swedish blockers) otherwise. The rules live in the STABLE
-- delete_empty_fiscal_period_preview, which is also the dry run (the MCP
-- staging preview reads it without writing); the writer runs it again under
-- the row lock before it deletes:
--   - another year starts earlier (only the first year can go, so the chain
--     of years stays contiguous), or it is the company's only year;
--   - the year is closed, klarmarkerat, locked, behind the company lock date,
--     held by an SIE import or an opening-balance review;
--   - any journal_entries row of any status (posted, reversed, cancelled,
--     draft) belongs to it;
--   - a verifikationsnummer was ever issued in it (voucher_sequences with
--     last_number > 0: BFNAR 2013:2, a series that started stays accounted
--     for);
--   - an SIE import, or any other row in a table with a foreign key to
--     fiscal_periods, points at it (read from the catalog, so a table added
--     later is covered without touching this function);
--   - an annual filing for the year's label is submitted or confirmed.
-- On success the next year's previous_period_id is cleared (it becomes the
-- first year), the row is deleted (audit_fiscal_periods writes the DELETE
-- with the full old row) and one more audit_log row names the person who
-- removed it. p_user_id is honored only for service-role callers (same actor
-- rule as redate_fiscal_period).
--
-- 2. pending_operations.operation_type gains delete_fiscal_period (the MCP
--    tool gnubok_delete_fiscal_period stages it), expanded from the
--    constraint's current definition (the 20261027120100 pattern).
--
-- No enforcement trigger is touched.
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
                              'public.fiscal_periods'::regclass)
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

COMMENT ON FUNCTION public.delete_empty_fiscal_period_preview(uuid, uuid, uuid) IS
  'Read-only answer to whether delete_empty_fiscal_period would remove this räkenskapsår: ok with the period, or FISCAL_PERIOD_DELETE_BLOCKED with Swedish blockers, PERIOD_NOT_FOUND or FORBIDDEN. The dry run and MCP staging preview. crm#1450.';

CREATE OR REPLACE FUNCTION public.delete_empty_fiscal_period(
  p_company_id uuid,
  p_period_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_end_user boolean := public.jwt_caller_is_end_user()
                        OR coalesce(current_setting('role', true), '') IN ('anon', 'authenticated');
  v_actor    uuid;
  v_check    jsonb;
  v_period   public.fiscal_periods%ROWTYPE;
BEGIN
  IF v_end_user THEN
    v_actor := auth.uid();
  ELSE
    v_actor := COALESCE(p_user_id, auth.uid());
  END IF;

  -- The gate and every rule first, then again under the row lock: FOR UPDATE
  -- conflicts with the FOR KEY SHARE lock a journal_entries insert takes on
  -- its period, so no verifikat can land in the year between the check and
  -- the DELETE.
  v_check := public.delete_empty_fiscal_period_preview(p_company_id, p_period_id, v_actor);
  IF NOT (v_check ->> 'ok')::boolean THEN
    RETURN v_check;
  END IF;
  SELECT * INTO v_period
    FROM public.fiscal_periods
   WHERE id = p_period_id
     AND company_id = p_company_id
     FOR UPDATE;
  v_check := public.delete_empty_fiscal_period_preview(p_company_id, p_period_id, v_actor);
  IF NOT (v_check ->> 'ok')::boolean THEN
    RETURN v_check;
  END IF;

  BEGIN
    UPDATE public.fiscal_periods
       SET previous_period_id = NULL
     WHERE company_id = p_company_id
       AND previous_period_id = p_period_id;

    DELETE FROM public.fiscal_periods
     WHERE id = p_period_id
       AND company_id = p_company_id;
  EXCEPTION WHEN foreign_key_violation THEN
    -- A row pointing at the year arrived after the reads above.
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FISCAL_PERIOD_DELETE_BLOCKED',
      'blockers', jsonb_build_array(jsonb_build_object(
        'code', 'linked_records',
        'message_sv', 'Räkenskapsåret har kopplade uppgifter.')));
  END;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, description)
  VALUES (
    v_actor, p_company_id, 'DELETE', 'fiscal_periods', p_period_id, v_actor, to_jsonb(v_period),
    format('Removed empty first fiscal period "%s" (%s to %s)', v_period.name,
           to_char(v_period.period_start, 'YYYY-MM-DD'), to_char(v_period.period_end, 'YYYY-MM-DD')));

  RETURN jsonb_build_object('ok', true, 'period', to_jsonb(v_period));
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_empty_fiscal_period(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_empty_fiscal_period(uuid, uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.delete_empty_fiscal_period(uuid, uuid, uuid) IS
  'Remove the company''s first räkenskapsår when it holds nothing (no verifikat or draft of any status, no issued voucher number, no SIE import, no row in any table referencing it, not closed, locked, held or filed), refusing with FISCAL_PERIOD_DELETE_BLOCKED and Swedish blockers otherwise, after the same check under the row lock (delete_empty_fiscal_period_preview). p_user_id is honored only for service-role callers. crm#1450.';

-- =============================================================================
-- 2. pending_operations.operation_type: delete_fiscal_period
-- =============================================================================

SELECT set_config('lock_timeout', '5s', true);

DO $$
DECLARE
  v_types text[];
  v_new text;
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  FOREACH v_new IN ARRAY ARRAY['delete_fiscal_period'] LOOP
    IF NOT (v_new = ANY (v_types)) THEN
      v_types := v_types || v_new;
    END IF;
  END LOOP;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

-- The CHECK only grew, so every existing row still satisfies it; validating
-- here reads the table once (about 70k rows) instead of a second migration.
ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;

NOTIFY pgrst, 'reload schema';
