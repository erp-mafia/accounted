-- Security fix: retag_line_dimensions trusted the caller's p_user_id.
--
-- The installed definition (20260702230000, whose tenant guard
-- 20260703180000 later rewrote in place to caller_is_company_member, kept
-- below) resolves its actor from COALESCE(p_user_id, auth.uid()) and
-- EXECUTE is granted to authenticated.
-- The tenant guard only checks that the JWT caller is a member of the
-- company, and the writer gate then reads the role of v_actor, not of the
-- caller. Any writer member could therefore POST /rest/v1/rpc/
-- retag_line_dimensions with another member's UUID as p_user_id and have
-- that person recorded as the actor in dimension_retag_log: a forged
-- behandlingshistorik attribution (BFL 5 kap. 11 §, BFNAR 2013:2 p. 9.16).
-- A viewer could even borrow a writer's UUID to walk through the writer
-- gate itself.
--
-- The sibling rättelse RPCs were closed the same way already:
-- correct_entry_metadata and correct_entry_lines_inline pin JWT callers to
-- auth.uid() (20260723210000, restated by 20260831150000), undo_sie_import
-- honours p_user_id for the service role only (20260727121000). Here:
--   * JWT callers (anon/authenticated): the actor is auth.uid(). A non-null
--     p_user_id that names someone else is refused with 42501 rather than
--     silently ignored, so a tampered call fails loudly instead of being
--     logged under a different name than the one it asked for.
--   * service_role and no-JWT callers keep p_user_id: they authenticate the
--     user application-side.
--
-- Legitimate callers, checked in src/:
--   * POST /api/bookkeeping/journal-entry-lines/[lineId]/retag and
--     POST /api/dimensions/tagging/apply: withRouteContext hands them the
--     cookie session client (JWT authenticated) and they pass p_user_id =
--     user.id, which is auth.uid(): accepted, same actor as before.
--   * commitRetagLineDimensions (src/lib/pending-operations/commit.ts): the
--     in-app approve and bulk-commit routes use the session client with the
--     approver's user.id (= auth.uid()): accepted. MCP approvals use
--     createServiceClientNoCookies (service_role JWT) with the key owner's
--     id: p_user_id kept.
--
-- Second change: the transaction-local gnubok.allow_dimension_retag flag is
-- reset right after the UPDATE, the way the rättelse RPCs reset theirs
-- (20260723210000, 20260831150000). Before, it stayed 'true' for the rest of
-- the caller's transaction, so a direct UPDATE of any posted line's
-- dimensions later in that transaction passed the carve-out with no audit
-- row.
--
-- Everything else is byte-identical to 20260702230000: signature, body,
-- SECURITY DEFINER and SET search_path (CREATE OR REPLACE resets proconfig,
-- so it is restated), except that its em dashes (four comments and four
-- RAISE texts) became colons, as 20260819092408 did for the rättelse RPC;
-- every message keeps its wording. Grants restated for auditability. No caller in
-- src/ changes.
--
-- pg-test: tests/pg/dimension-retag.pg.test.ts

CREATE OR REPLACE FUNCTION public.retag_line_dimensions(
  p_company_id uuid,
  p_line_id    uuid,
  p_dimensions jsonb,
  p_reason     text,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role   text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor      uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role text;
  v_line       record;
  v_is_closed  boolean;
  v_locked_at  timestamptz;
  v_lock_date  date;
  v_key        text;
  v_value      text;
  v_log_id     uuid;
BEGIN
  -- Tenant guard (20260619130100 pattern): anon/authenticated JWTs must be
  -- members; service_role/no-JWT callers are scoped by the application layer.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Actor pinning (20260928200000): the actor is the behandlingshistorik
  -- attribution of this change, so a JWT caller can never name someone
  -- else. p_user_id is only for service_role/no-JWT callers, which
  -- authenticate the user application-side.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Du kan inte ange en annan användare som utförare av ändringen.'
        USING ERRCODE = '42501';
    END IF;
    v_actor := auth.uid();
  END IF;

  -- Writer gate: any member except viewers (Fortnox parity: retag is
  -- ordinary bookkeeping work, not an admin operation).
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan ändra dimensioner.';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Ange en anledning till ändringen (minst 3 tecken).';
  END IF;

  IF p_dimensions IS NULL OR jsonb_typeof(p_dimensions) <> 'object' THEN
    RAISE EXCEPTION 'Dimensionerna måste vara ett objekt ({"1":"KS01","6":"P001"}).';
  END IF;

  -- Lock the line + parent entry state.
  SELECT jel.id, jel.dimensions, je.id AS entry_id, je.status, je.entry_date,
         je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_line
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE jel.id = p_line_id
     FOR UPDATE OF jel;

  IF NOT FOUND OR v_line.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationsraden hittades inte.';
  END IF;

  IF v_line.status <> 'posted' THEN
    RAISE EXCEPTION 'Endast rader på bokförda verifikat kan taggas om (utkast redigeras direkt).';
  END IF;

  -- Tier boundaries: open periods only, company lock date honored.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_line.fiscal_period_id;

  IF v_is_closed THEN
    RAISE EXCEPTION 'Perioden är stängd: använd rättelseverifikat (storno) för att ändra dimensioner.';
  END IF;
  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är låst: använd rättelseverifikat (storno) för att ändra dimensioner.';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_line.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. %: använd rättelseverifikat (storno).', v_lock_date;
  END IF;

  -- Validate every (dimension, code) pair against the ACTIVE registry.
  -- Retag is a deliberate act on history: unlike import passthrough it
  -- must reference real, active registry values (same posture as the
  -- engine's soft validation for NEW entries).
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

  -- Idempotent no-op: nothing to log, nothing to write.
  IF v_line.dimensions = p_dimensions THEN
    RETURN jsonb_build_object('changed', false, 'log_id', NULL);
  END IF;

  -- Immutable before/after audit row FIRST: the trigger carve-out is only
  -- ever exercised in a transaction that has already recorded the change.
  INSERT INTO public.dimension_retag_log
    (company_id, journal_entry_id, line_id, old_dimensions, new_dimensions, actor, reason)
  VALUES
    (p_company_id, v_line.entry_id, p_line_id, v_line.dimensions, p_dimensions, v_actor, btrim(p_reason))
  RETURNING id INTO v_log_id;

  -- Transaction-local GUC → the carve-out admits exactly this UPDATE.
  PERFORM set_config('gnubok.allow_dimension_retag', 'true', true);

  -- PR9: write the bag only; cost_center/project are GENERATED and
  -- recompute from the bag in the same statement.
  UPDATE public.journal_entry_lines
     SET dimensions = p_dimensions
   WHERE id = p_line_id;

  -- 20260928200000: close the carve-out again so it admits exactly the
  -- UPDATE above and nothing that runs later in the caller's transaction.
  PERFORM set_config('gnubok.allow_dimension_retag', 'false', true);

  RETURN jsonb_build_object(
    'changed', true,
    'log_id', v_log_id,
    'old_dimensions', v_line.dimensions,
    'new_dimensions', p_dimensions
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.retag_line_dimensions(uuid, uuid, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retag_line_dimensions(uuid, uuid, jsonb, text, uuid) TO authenticated, service_role;
