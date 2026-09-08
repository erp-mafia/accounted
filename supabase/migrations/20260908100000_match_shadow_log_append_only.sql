-- Migration: match_shadow_log append-only
--
-- The shadow log is what thresholds and earned autonomy are measured on, so
-- a company member must not be able to rewrite a decision or delete a row.
-- Rows are append-only: the only change a row ever takes is its human
-- outcome, set once, through record_match_shadow_outcome. The application
-- routes that learn the outcome (match, unmatch, approve, reject) call that
-- function instead of updating the table.

DROP POLICY IF EXISTS "update own-company match_shadow_log" ON public.match_shadow_log;
DROP POLICY IF EXISTS "delete own-company match_shadow_log" ON public.match_shadow_log;

-- Belt and braces above the policies: even the service role may only set an
-- outcome, once, and never touch what the matcher decided.
CREATE OR REPLACE FUNCTION public.match_shadow_log_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.trigger IS DISTINCT FROM OLD.trigger
     OR NEW.inbox_item_id IS DISTINCT FROM OLD.inbox_item_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.counterparty_key IS DISTINCT FROM OLD.counterparty_key
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.calibrated_p IS DISTINCT FROM OLD.calibrated_p
     OR NEW.components IS DISTINCT FROM OLD.components
     OR NEW.decision IS DISTINCT FROM OLD.decision
     OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.acted IS DISTINCT FROM OLD.acted
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'match_shadow_log is append-only: only the human outcome may be set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.human_outcome IS NOT NULL
     AND (NEW.human_outcome IS DISTINCT FROM OLD.human_outcome OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at) THEN
    RAISE EXCEPTION 'match_shadow_log outcome is set once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER match_shadow_log_guard_update
  BEFORE UPDATE ON public.match_shadow_log
  FOR EACH ROW EXECUTE FUNCTION public.match_shadow_log_guard_update();

CREATE TRIGGER match_shadow_log_no_delete
  BEFORE DELETE ON public.match_shadow_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();

-- The one sanctioned write after insert. A member of the company (or the
-- service role, which carries no auth.uid()) stamps what the human did with
-- a document on every open row for it: agree when they landed on the
-- transaction the matcher chose, rejected when they refused that pair,
-- disagree otherwise. Returns the number of rows stamped.
CREATE OR REPLACE FUNCTION public.record_match_shadow_outcome(
  p_company_id uuid,
  p_document_id uuid,
  p_transaction_id uuid DEFAULT NULL,
  p_rejected_transaction_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  IF p_company_id IS NULL OR p_document_id IS NULL THEN
    RETURN 0;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT (p_company_id IN (SELECT public.user_company_ids())) THEN
    RAISE EXCEPTION 'not a member of the company' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.match_shadow_log
     SET human_outcome = CASE
           WHEN p_rejected_transaction_id IS NOT NULL AND transaction_id = p_rejected_transaction_id THEN 'rejected'
           WHEN p_transaction_id IS NOT NULL AND transaction_id = p_transaction_id THEN 'agree'
           ELSE 'disagree'
         END,
         outcome_at = now()
   WHERE company_id = p_company_id
     AND document_id = p_document_id
     AND human_outcome IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.record_match_shadow_outcome(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_match_shadow_outcome(uuid, uuid, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_match_shadow_outcome(uuid, uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
