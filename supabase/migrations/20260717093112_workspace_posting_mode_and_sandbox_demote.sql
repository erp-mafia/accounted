-- Workspace-first posting mode + sandbox demote of posted vouchers to drafts.
--
-- posting_mode:
--   'direct'          — legacy: createJournalEntry posts immediately (default)
--   'workspace_first' — user/agent bookkeeping lands as draft until Fastställ
--
-- demote_sandbox_vouchers_to_draft:
--   Sandbox-only. Moves the latest posted vouchers (last-in-series per open
--   period) back to draft so Att bokföra can be practised. Production
--   companies are rejected. Uses gnubok.allow_sandbox_demote bypass on the
--   immutability trigger — NOT the same as delete_last_voucher.

-- 1. company_settings.posting_mode
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS posting_mode text NOT NULL DEFAULT 'direct';

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_posting_mode_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_posting_mode_check
  CHECK (posting_mode IN ('direct', 'workspace_first'));

COMMENT ON COLUMN public.company_settings.posting_mode IS
  'direct = post JE immediately; workspace_first = create draft until Fastställ on Att bokföra';

-- 2. Immutability: allow posted→draft only under sandbox demote bypass
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  -- Sandbox demote: posted → draft with voucher_number cleared (Att bokföra practice).
  IF OLD.status = 'posted' AND NEW.status = 'draft'
     AND current_setting('gnubok.allow_sandbox_demote', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields during un-reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at')
       = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$function$;

-- 3. Sandbox demote RPC (also sets posting_mode = workspace_first)
CREATE OR REPLACE FUNCTION public.demote_sandbox_vouchers_to_draft(
  p_company_id uuid,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text;
  v_is_sandbox boolean;
  v_limit integer;
  v_demoted integer := 0;
  v_entry record;
  v_max_voucher integer;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    v_limit := 50;
  ELSE
    v_limit := LEAST(p_limit, 200);
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can demote vouchers';
  END IF;

  SELECT cs.is_sandbox INTO v_is_sandbox
  FROM company_settings cs
  WHERE cs.company_id = p_company_id;

  IF v_is_sandbox IS NOT TRUE THEN
    RAISE EXCEPTION 'demote_sandbox_vouchers_to_draft is only allowed for sandbox companies';
  END IF;

  UPDATE company_settings
  SET posting_mode = 'workspace_first'
  WHERE company_id = p_company_id
    AND posting_mode IS DISTINCT FROM 'workspace_first';

  -- Repeatedly demote the current last voucher in any open, unlocked period
  -- (same last-in-series rule as delete_last_voucher) up to v_limit times.
  LOOP
    EXIT WHEN v_demoted >= v_limit;

    SELECT je.* INTO v_entry
    FROM journal_entries je
    JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND fp.is_closed IS NOT TRUE
      AND fp.locked_at IS NULL
      AND je.voucher_number > 0
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries ref
        WHERE ref.company_id = p_company_id
          AND ref.status != 'cancelled'
          AND (ref.reverses_id = je.id OR ref.correction_of_id = je.id)
      )
      AND je.voucher_number = (
        SELECT MAX(je2.voucher_number)
        FROM journal_entries je2
        WHERE je2.company_id = je.company_id
          AND je2.fiscal_period_id = je.fiscal_period_id
          AND je2.voucher_series = je.voucher_series
          AND je2.status NOT IN ('cancelled', 'draft')
      )
    ORDER BY je.entry_date DESC, je.voucher_number DESC
    LIMIT 1
    FOR UPDATE OF je;

    EXIT WHEN NOT FOUND;

    PERFORM set_config('gnubok.allow_sandbox_demote', 'true', true);

    UPDATE journal_entries
    SET
      status = 'draft',
      voucher_number = 0,
      commit_method = NULL,
      committed_at = NULL,
      committed_actor_type = NULL,
      committed_actor_label = NULL
    WHERE id = v_entry.id;

    SELECT COALESCE(MAX(voucher_number), 0) INTO v_max_voucher
    FROM journal_entries
    WHERE company_id = p_company_id
      AND fiscal_period_id = v_entry.fiscal_period_id
      AND voucher_series = v_entry.voucher_series
      AND status NOT IN ('cancelled', 'draft');

    UPDATE voucher_sequences
    SET last_number = v_max_voucher
    WHERE company_id = p_company_id
      AND fiscal_period_id = v_entry.fiscal_period_id
      AND voucher_series = v_entry.voucher_series;

    INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, description)
    VALUES (
      v_entry.user_id,
      p_company_id,
      'UPDATE',
      'journal_entries',
      v_entry.id,
      auth.uid(),
      to_jsonb(v_entry),
      'Sandbox demote posted→draft (Att bokföra practice); voucher '
        || v_entry.voucher_series || v_entry.voucher_number::text
        || ' cleared'
    );

    v_ids := array_append(v_ids, v_entry.id);
    v_demoted := v_demoted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'demoted', v_demoted,
    'entry_ids', to_jsonb(v_ids),
    'posting_mode', 'workspace_first'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.demote_sandbox_vouchers_to_draft(uuid, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
