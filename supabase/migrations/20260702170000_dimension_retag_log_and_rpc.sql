-- Dimensions plan PR6 (retro-tagging Tier 2) — founder decision №1 APPROVED
-- 2026-07-02 (dev_docs/dimensions_implementation_plan.md §3, §8).
--
-- Posted entries in OPEN periods may have their dimension tags changed
-- through ONE audited path: the retag_line_dimensions RPC. Everything about
-- the verifikat itself (accounts, amounts, description, currency, linkage)
-- stays absolutely immutable — the line-immutability trigger gains a single
-- narrow carve-out that permits an UPDATE iff every non-dimension column is
-- unchanged, and only while the transaction-local GUC set by the RPC is
-- active.
--
-- Legal position (recorded in the plan): BFL 5 kap 7§'s mandatory verifikat
-- content does not include kontering/dimension coding — dimensions are
-- internredovisning metadata. Fortnox and Visma both permit editing
-- KS/projekt on posted vouchers in open periods without a
-- rättelseverifikation. This design is strictly more conservative than both:
-- dimension-only diffs, open periods only, company lock date honored,
-- immutable before/after log, storno past locks (Tier 3 — no exceptions).
--
-- The carve-out follows the sanctioned precedent of
-- 20260613120000_mark_entry_as_opening_balance.sql (entries-trigger
-- source_type retag: GUC + whole-row to_jsonb diff). The mirror columns
-- cost_center/project are included in the changeable set because they are
-- derived views of dimensions['1']/['6'] (dual-write invariant from the
-- substrate migration) — leaving them stale would split every report.
--
-- pg-test: tests/pg/dimension-retag.pg.test.ts

-- =============================================================================
-- 1. dimension_retag_log — immutable before/after audit trail
-- =============================================================================
-- Audit-trail semantics like audit_log: no FKs to lines/entries, so the log
-- survives hard-deletes (undo_sie_import) — behandlingshistorik must not
-- vanish with its subject. company FK keeps tenant lifecycle.

CREATE TABLE public.dimension_retag_log (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  journal_entry_id  uuid NOT NULL,
  line_id           uuid NOT NULL,
  old_dimensions    jsonb NOT NULL,
  new_dimensions    jsonb NOT NULL,
  actor             uuid,
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dimension_retag_log ENABLE ROW LEVEL SECURITY;

-- Read-only for members; INSERT happens exclusively inside the SECURITY
-- DEFINER RPC (no INSERT/UPDATE/DELETE policies on purpose).
CREATE POLICY "view own-company dimension_retag_log"
  ON public.dimension_retag_log FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_dimension_retag_log_entry
  ON public.dimension_retag_log (company_id, journal_entry_id);
CREATE INDEX idx_dimension_retag_log_line
  ON public.dimension_retag_log (line_id);

-- INSERT-only: the log is itself räkenskapsinformation-adjacent audit trail.
CREATE OR REPLACE FUNCTION public.dimension_retag_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'dimension_retag_log är oföränderlig — rader kan inte ändras eller tas bort.';
END;
$$;

CREATE TRIGGER dimension_retag_log_immutable
  BEFORE UPDATE OR DELETE ON public.dimension_retag_log
  FOR EACH ROW EXECUTE FUNCTION public.dimension_retag_log_immutable();

-- =============================================================================
-- 2. Line-immutability carve-out (append-only replacement; precedent:
--    the function has been replaced three times, see 20260415000000 §4d)
-- =============================================================================
-- The whole-row to_jsonb diff makes the protection exhaustive BY
-- CONSTRUCTION: any column added to journal_entry_lines in the future is
-- automatically immutable under the GUC until explicitly exempted here.
-- (journal_entry_lines has no updated_at column, so no timestamp exemption.)

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_status text;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  -- Dimension retag carve-out (dimensions plan PR6, founder-approved):
  -- while the transaction-local GUC set by retag_line_dimensions is active,
  -- permit UPDATE of a POSTED line iff ONLY the dimension columns change —
  -- dimensions (source of truth) and its derived mirrors cost_center/project.
  -- Account, amounts, description, currency fields, sort order and entry
  -- linkage remain absolutely immutable.
  IF TG_OP = 'UPDATE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_dimension_retag', true) = 'true'
     AND (to_jsonb(NEW) - 'dimensions' - 'cost_center' - 'project')
       = (to_jsonb(OLD) - 'dimensions' - 'cost_center' - 'project') THEN
    RETURN NEW;
  END IF;

  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END; $function$;

-- Restore the hardening applied by 20260304191528 (CREATE OR REPLACE would
-- otherwise leave the new definition without a pinned search_path).
ALTER FUNCTION public.enforce_journal_entry_line_immutability() SET search_path = public;

-- =============================================================================
-- 3. retag_line_dimensions — the ONE write path
-- =============================================================================

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
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Writer gate: any member except viewers (Fortnox parity — retag is
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
    RAISE EXCEPTION 'Perioden är stängd — använd rättelseverifikat (storno) för att ändra dimensioner.';
  END IF;
  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är låst — använd rättelseverifikat (storno) för att ändra dimensioner.';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_line.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. % — använd rättelseverifikat (storno).', v_lock_date;
  END IF;

  -- Validate every (dimension, code) pair against the ACTIVE registry.
  -- Retag is a deliberate act on history — unlike import passthrough it
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
      RAISE EXCEPTION 'Värdet "%" finns inte som aktivt värde för dimension % — registrera eller återaktivera det först.', v_value, v_key;
    END IF;
  END LOOP;

  -- Idempotent no-op: nothing to log, nothing to write.
  IF v_line.dimensions = p_dimensions THEN
    RETURN jsonb_build_object('changed', false, 'log_id', NULL);
  END IF;

  -- Immutable before/after audit row FIRST — the trigger carve-out is only
  -- ever exercised in a transaction that has already recorded the change.
  INSERT INTO public.dimension_retag_log
    (company_id, journal_entry_id, line_id, old_dimensions, new_dimensions, actor, reason)
  VALUES
    (p_company_id, v_line.entry_id, p_line_id, v_line.dimensions, p_dimensions, v_actor, btrim(p_reason))
  RETURNING id INTO v_log_id;

  -- Transaction-local GUC → the carve-out admits exactly this UPDATE.
  PERFORM set_config('gnubok.allow_dimension_retag', 'true', true);

  UPDATE public.journal_entry_lines
     SET dimensions  = p_dimensions,
         cost_center = NULLIF(p_dimensions ->> '1', ''),
         project     = NULLIF(p_dimensions ->> '6', '')
   WHERE id = p_line_id;

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

NOTIFY pgrst, 'reload schema';
