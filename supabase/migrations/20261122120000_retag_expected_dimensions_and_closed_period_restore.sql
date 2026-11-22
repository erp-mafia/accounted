-- Dimension retag: optimistic check against a planned value, and a narrow,
-- audited path for restoring LOST dimension tags in closed periods.
--
-- pg-test: tests/pg/dimension-retag-expected.pg.test.ts
--
-- Nothing existing changes. retag_line_dimensions(uuid, uuid, jsonb, text,
-- uuid) keeps its body, grants and behaviour; the line-immutability trigger
-- (enforce_journal_entry_line_immutability) is not touched; no period lock is
-- relaxed for retag_line_dimensions.
--
-- ── 1. retag_line_dimensions(..., p_expected_dimensions) ──────────────────
-- A bulk retag is usually planned first (dry run) and applied later. The
-- 5-argument RPC locks the line but cannot know what the caller planned
-- from, so a manual retag made in between would be silently overwritten.
-- This overload takes the dimensions the caller expects the line to have,
-- locks the line, compares, and then delegates to the 5-argument function in
-- the SAME transaction (same row lock), so every existing check and the
-- immutable dimension_retag_log row still apply. NULL and '{}' both mean
-- "untagged" and compare equal. A mismatch raises SQLSTATE 40001 and writes
-- nothing. No DEFAULT on p_expected_dimensions: a 4- or 5-argument call can
-- only resolve to the existing function.
--
-- ── 2. restore_closed_period_line_dimensions ───────────────────────────────
-- retag_line_dimensions refuses closed/locked periods (storno past locks).
-- That is right for CHANGING a tag, but it leaves no way to put back tags
-- that the original bookkeeping carried and that were lost on the way in
-- (e.g. a SIE import that dropped the #TRANS object list) once the year is
-- closed. A storno cannot fix that either: it would add verifikat to a closed
-- year to repair metadata the original verifikat already had.
--
-- This function is deliberately much narrower than the open-period path:
--   * service_role only (no EXECUTE for anon/authenticated): a back-office
--     restore job, never an end-user action;
--   * p_user_id must be owner or admin of the company and is logged as actor;
--   * only lines in a closed or locked period, or dated on/before
--     company_settings.bookkeeping_locked_through (open periods must use
--     retag_line_dimensions);
--   * only posted verifikat;
--   * only UNTAGGED lines (dimensions NULL or '{}'), and the caller must
--     state that expectation (p_expected_dimensions = '{}'): an existing tag
--     can never be changed or removed this way;
--   * only active registry values, non-empty object;
--   * writes ONLY the dimensions column, through the existing
--     gnubok.allow_dimension_retag carve-out of
--     enforce_journal_entry_line_immutability, which already rejects any
--     UPDATE where a non-dimension column differs. Amounts, accounts, dates
--     and texts therefore cannot change, and the trigger is unchanged;
--   * one immutable dimension_retag_log row per line, written BEFORE the
--     update, with the reason prefixed "[stängd period]".

-- =============================================================================
-- 1. retag_line_dimensions with expected dimensions
-- =============================================================================

CREATE OR REPLACE FUNCTION public.retag_line_dimensions(
  p_company_id          uuid,
  p_line_id             uuid,
  p_dimensions          jsonb,
  p_reason              text,
  p_user_id             uuid,
  p_expected_dimensions jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_current  jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_expected_dimensions IS NULL OR jsonb_typeof(p_expected_dimensions) <> 'object' THEN
    RAISE EXCEPTION 'Förväntade dimensioner måste vara ett objekt ({} för otaggad rad).';
  END IF;

  SELECT jel.dimensions INTO v_current
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE jel.id = p_line_id
     AND je.company_id = p_company_id
     FOR UPDATE OF jel;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verifikationsraden hittades inte.';
  END IF;

  IF coalesce(v_current, '{}'::jsonb) IS DISTINCT FROM p_expected_dimensions THEN
    RAISE EXCEPTION 'Raden har ändrats sedan planen (förväntat %, nu %).',
      p_expected_dimensions, coalesce(v_current, '{}'::jsonb)
      USING ERRCODE = '40001';
  END IF;

  -- Same transaction and row lock: every other check plus the log row.
  RETURN public.retag_line_dimensions(p_company_id, p_line_id, p_dimensions, p_reason, p_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.retag_line_dimensions(uuid, uuid, jsonb, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retag_line_dimensions(uuid, uuid, jsonb, text, uuid, jsonb) TO authenticated, service_role;

-- =============================================================================
-- 2. restore_closed_period_line_dimensions
-- =============================================================================

CREATE OR REPLACE FUNCTION public.restore_closed_period_line_dimensions(
  p_company_id          uuid,
  p_line_id             uuid,
  p_dimensions          jsonb,
  p_reason              text,
  p_user_id             uuid,
  p_expected_dimensions jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role  text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_line      record;
  v_is_closed boolean;
  v_locked_at timestamptz;
  v_lock_date date;
  v_key       text;
  v_value     text;
  v_reason    text := '[stängd period] ' || btrim(coalesce(p_reason, ''));
  v_log_id    uuid;
BEGIN
  -- Defence in depth: EXECUTE is service_role only (see grants below).
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'unauthorized: endast för servicerollen.'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members cm
     WHERE cm.company_id = p_company_id
       AND cm.user_id = p_user_id
       AND cm.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Endast ägare eller admin kan återställa dimensioner i stängd period.'
      USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Ange en anledning till återställningen (minst 10 tecken).';
  END IF;

  IF p_expected_dimensions IS NULL OR p_expected_dimensions <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Stängd period: endast otaggade rader kan återställas (förväntat måste vara {}).';
  END IF;

  IF p_dimensions IS NULL OR jsonb_typeof(p_dimensions) <> 'object'
     OR p_dimensions = '{}'::jsonb THEN
    RAISE EXCEPTION 'Dimensionerna måste vara ett icke-tomt objekt ({"1":"KS01"}).';
  END IF;

  SELECT jel.dimensions, je.id AS entry_id, je.status, je.entry_date, je.fiscal_period_id
    INTO v_line
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE jel.id = p_line_id
     AND je.company_id = p_company_id
     FOR UPDATE OF jel;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verifikationsraden hittades inte.';
  END IF;

  IF v_line.status <> 'posted' THEN
    RAISE EXCEPTION 'Endast rader på bokförda verifikat kan återställas.';
  END IF;

  -- Closed-period path only: open periods go through retag_line_dimensions.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_line.fiscal_period_id;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF NOT (coalesce(v_is_closed, false)
          OR v_locked_at IS NOT NULL
          OR (v_lock_date IS NOT NULL AND v_line.entry_date <= v_lock_date)) THEN
    RAISE EXCEPTION 'Perioden är öppen: använd retag_line_dimensions.';
  END IF;

  IF coalesce(v_line.dimensions, '{}'::jsonb) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Raden har ändrats sedan planen (förväntat {}, nu %).', v_line.dimensions
      USING ERRCODE = '40001';
  END IF;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each_text(p_dimensions)
  LOOP
    IF v_key !~ '^[1-9][0-9]{0,3}$' THEN
      RAISE EXCEPTION 'Ogiltigt dimensionsnummer: %.', v_key;
    END IF;
    IF v_value IS NULL OR length(btrim(v_value)) = 0 THEN
      RAISE EXCEPTION 'Dimension % saknar kod.', v_key;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.dimensions d
        JOIN public.dimension_values dv
          ON dv.dimension_id = d.id AND dv.company_id = d.company_id
       WHERE d.company_id = p_company_id
         AND d.sie_dim_no = v_key::int
         AND d.is_active
         AND dv.code = v_value
         AND dv.is_active
    ) THEN
      RAISE EXCEPTION 'Värdet "%" finns inte som aktivt värde för dimension %: registrera eller återaktivera det först.', v_value, v_key;
    END IF;
  END LOOP;

  -- Immutable audit row first, then the dimension-only UPDATE under the
  -- existing transaction-local carve-out.
  INSERT INTO public.dimension_retag_log
    (company_id, journal_entry_id, line_id, old_dimensions, new_dimensions, actor, reason)
  VALUES
    (p_company_id, v_line.entry_id, p_line_id, coalesce(v_line.dimensions, '{}'::jsonb),
     p_dimensions, p_user_id, v_reason)
  RETURNING id INTO v_log_id;

  PERFORM set_config('gnubok.allow_dimension_retag', 'true', true);
  UPDATE public.journal_entry_lines
     SET dimensions = p_dimensions
   WHERE id = p_line_id;
  PERFORM set_config('gnubok.allow_dimension_retag', '', true);

  RETURN jsonb_build_object(
    'changed', true,
    'closed_period', true,
    'log_id', v_log_id,
    'old_dimensions', coalesce(v_line.dimensions, '{}'::jsonb),
    'new_dimensions', p_dimensions
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_closed_period_line_dimensions(uuid, uuid, jsonb, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_closed_period_line_dimensions(uuid, uuid, jsonb, text, uuid, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
