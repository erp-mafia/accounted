-- Suggestions: a staged operation the system proposes, at most one open per
-- company and suggestion, and the company's answer remembered.
--
-- Profiles and Suggestions, step 3. A detector (src/lib/suggestions) watches
-- an event (the first employee registered, a till or webshop connected) or a
-- schedule, checks a condition, and proposes an operation: today a package
-- switch (enable_package, disable_package). The proposal is an ordinary
-- pending_operations row with actor 'system', so it is approved or rejected
-- through the doors every staged operation already has (Att göra, /pending,
-- v1, MCP), with the receipt, audit and actor they give. This table adds what
-- a suggestion needs beyond that:
--
-- 1. company_suggestions: one row per company and suggestion_key
--    (e.g. enable_package:payroll), holding its state:
--      open      a pending operation waits for an answer
--      snoozed   "Inte nu", or left unanswered until the operation expired,
--                or the approval failed: not proposed again before
--                snoozed_until (30 days)
--      declined  "Visa aldrig": never proposed again
--      accepted  approved and committed; proposed again only if the
--                condition comes back (the package switched off again)
--    and the rank that orders what Att göra and the agent briefing show (at
--    most three at a time, ranked; the rest wait).
--
-- 2. stage_company_suggestion: the detectors' one write. Under a per-company,
--    per-key advisory lock it skips a declined key, a snoozed key whose time
--    has not come, and an open key whose operation is still pending; else it
--    inserts the pending operation (actor 'system', label 'Accounted') and
--    marks the key open. Atomic, so two events at once stage it once. When
--    the database does not have the operation type yet, the INSERT raises
--    check_violation and nothing is written; the caller logs and skips
--    (deploy-order safety). service_role only.
--
-- 3. sync_company_suggestion_decision, AFTER UPDATE OF status on
--    pending_operations for the two package operation types: keeps the key's
--    state in step with every door's decision. Committed: accepted. Rejected
--    with the reason "Visa aldrig" (or "never"): declined. Any other
--    rejection (a plain no, "Inte nu", the 30-day expiry, a refused
--    approval) or failed_partial: snoozed for 30 days. The existing approve
--    and reject tools therefore carry all three answers.
--
-- pg-test: tests/pg/company-suggestions.pg.test.ts

-- pending_operations is written on every staging and approval; the trigger
-- below takes a lock on it: fail the migration job instead of queueing.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. company_suggestions
-- =============================================================================

CREATE TABLE public.company_suggestions (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  suggestion_key       text NOT NULL CHECK (suggestion_key ~ '^[a-z_]+:[a-z0-9-]+$' AND length(suggestion_key) <= 100),
  detector             text NOT NULL CHECK (detector ~ '^[a-z0-9-]+$' AND length(detector) <= 60),
  state                text NOT NULL CHECK (state IN ('open', 'snoozed', 'declined', 'accepted')),
  rank                 integer NOT NULL DEFAULT 0,
  pending_operation_id uuid REFERENCES public.pending_operations(id) ON DELETE SET NULL,
  snoozed_until        timestamptz,
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_suggestions_company_key UNIQUE (company_id, suggestion_key),
  CONSTRAINT company_suggestions_snoozed_until CHECK ((state = 'snoozed') = (snoozed_until IS NOT NULL))
);

COMMENT ON TABLE public.company_suggestions IS
  'One row per company and suggestion (a staged operation the system proposed, e.g. enable_package:payroll): open, snoozed until a date, declined for good, or accepted. The proposal and the decision themselves are the pending_operations row; written by stage_company_suggestion and kept in step by sync_company_suggestion_decision.';

CREATE INDEX idx_company_suggestions_pending_operation
  ON public.company_suggestions (pending_operation_id)
  WHERE pending_operation_id IS NOT NULL;

ALTER TABLE public.company_suggestions ENABLE ROW LEVEL SECURITY;

-- Members read their companies' suggestions (Att göra, the agent briefing).
-- Every write is the stage RPC or the decision trigger (service role and
-- SECURITY DEFINER): no write policy for members.
CREATE POLICY "members read company_suggestions"
  ON public.company_suggestions FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.company_suggestions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_suggestions TO service_role;
-- no-grant: anon on public.company_suggestions (company-scoped: members only)

CREATE TRIGGER set_updated_at_company_suggestions
  BEFORE UPDATE ON public.company_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. stage_company_suggestion
-- =============================================================================

CREATE FUNCTION public.stage_company_suggestion(
  p_company_id uuid,
  p_user_id uuid,
  p_suggestion_key text,
  p_detector text,
  p_rank integer,
  p_operation_type text,
  p_title text,
  p_params jsonb,
  p_preview_data jsonb,
  p_risk_level text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.company_suggestions;
  v_op_status text;
  v_op_id uuid;
BEGIN
  -- Serialise stagers of one key: two events at once (two employees saved
  -- together) must not both find the key free.
  PERFORM pg_advisory_xact_lock(hashtextextended('company-suggestion:' || p_company_id::text || ':' || p_suggestion_key, 0));

  SELECT * INTO v_row
    FROM public.company_suggestions
   WHERE company_id = p_company_id AND suggestion_key = p_suggestion_key
   FOR UPDATE;

  IF v_row.id IS NOT NULL THEN
    IF v_row.state = 'declined' THEN
      RETURN jsonb_build_object('staged', false, 'reason', 'declined', 'suggestion_id', v_row.id);
    END IF;
    IF v_row.state = 'snoozed' AND v_row.snoozed_until > now() THEN
      RETURN jsonb_build_object('staged', false, 'reason', 'snoozed', 'suggestion_id', v_row.id,
                                'snoozed_until', v_row.snoozed_until);
    END IF;
    IF v_row.state = 'open' AND v_row.pending_operation_id IS NOT NULL THEN
      SELECT status INTO v_op_status FROM public.pending_operations WHERE id = v_row.pending_operation_id;
      IF v_op_status IN ('pending', 'committing') THEN
        RETURN jsonb_build_object('staged', false, 'reason', 'open', 'suggestion_id', v_row.id,
                                  'pending_operation_id', v_row.pending_operation_id);
      END IF;
    END IF;
  END IF;

  INSERT INTO public.pending_operations (
    company_id, user_id, operation_type, title, params, preview_data, actor_type, actor_label, risk_level
  )
  VALUES (
    p_company_id, p_user_id, p_operation_type, p_title,
    coalesce(p_params, '{}'::jsonb) || jsonb_build_object('suggestion_key', p_suggestion_key),
    coalesce(p_preview_data, '{}'::jsonb),
    'system', 'Accounted', p_risk_level
  )
  RETURNING id INTO v_op_id;

  INSERT INTO public.company_suggestions (company_id, suggestion_key, detector, state, rank, pending_operation_id)
  VALUES (p_company_id, p_suggestion_key, p_detector, 'open', coalesce(p_rank, 0), v_op_id)
  ON CONFLICT (company_id, suggestion_key) DO UPDATE
     SET detector = EXCLUDED.detector,
         state = 'open',
         rank = EXCLUDED.rank,
         pending_operation_id = EXCLUDED.pending_operation_id,
         snoozed_until = NULL,
         decided_at = NULL
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('staged', true, 'suggestion_id', v_row.id, 'pending_operation_id', v_op_id);
END;
$$;

REVOKE ALL ON FUNCTION public.stage_company_suggestion(uuid, uuid, text, text, integer, text, text, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_company_suggestion(uuid, uuid, text, text, integer, text, text, jsonb, jsonb, text)
  TO service_role;

-- =============================================================================
-- 3. The decision, from whichever door made it
-- =============================================================================

CREATE FUNCTION public.sync_company_suggestion_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'committed' THEN
    UPDATE public.company_suggestions
       SET state = 'accepted', decided_at = now(), snoozed_until = NULL
     WHERE pending_operation_id = NEW.id AND state = 'open';
  ELSIF NEW.status = 'rejected'
        AND lower(btrim(coalesce(NEW.rejection_reason, ''))) IN ('visa aldrig', 'never') THEN
    UPDATE public.company_suggestions
       SET state = 'declined', decided_at = now(), snoozed_until = NULL
     WHERE pending_operation_id = NEW.id AND state = 'open';
  ELSIF NEW.status IN ('rejected', 'failed_partial') THEN
    UPDATE public.company_suggestions
       SET state = 'snoozed', decided_at = now(), snoozed_until = now() + interval '30 days'
     WHERE pending_operation_id = NEW.id AND state = 'open';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_company_suggestion_decision() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER pending_operations_sync_suggestion
  AFTER UPDATE OF status ON public.pending_operations
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.operation_type IN ('enable_package', 'disable_package'))
  EXECUTE FUNCTION public.sync_company_suggestion_decision();

NOTIFY pgrst, 'reload schema';
