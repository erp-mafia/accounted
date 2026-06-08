-- Agent attribution into the immutable layer, part 2 (agent_first_vision.md §8 P0-1).
--
-- 20260618120001 made commit_method record that an approval was agent-relayed
-- ('api_key'), but two gaps remained:
--
--   1. The trigger-written audit_log rows (the unconditional audit trail) never
--      populate actor_type/actor_label — the columns exist since 20260430120000
--      but write_audit_log() leaves them at DEFAULT 'user'/NULL, so an auditor
--      reading audit_log cannot distinguish agent-relayed commits from
--      first-party human sessions.
--   2. The actor LABEL (which credential, e.g. the API key name) never reaches
--      the immutable layer at all — it lives only in mutable, app-written
--      pending_operations/processing_history rows.
--
-- Mechanism: commit_journal_entry() gains p_actor_type/p_actor_label params
-- (DEFAULT NULL — every existing caller keeps working unchanged). The RPC sets
-- transaction-local GUCs (the established gnubok.allow_delete pattern from
-- 20260415000000) that write_audit_log() reads, and stamps the values onto two
-- new nullable journal_entries columns in the same draft→posted UPDATE that
-- already writes commit_method. PostgREST callers cannot set GUCs themselves
-- (each request is its own connection/transaction), so the RPC is the only
-- entry point — which is exactly the choke point we want (BFNAR 2013:2 kap 8
-- behandlingshistorik: automated processing must be identifiable).
--
-- Backwards compatibility:
--   - New columns are nullable, no backfill — same rollout as commit_method.
--   - write_audit_log COALESCEs an unset GUC to 'user', which is byte-identical
--     to today's effective behaviour (column DEFAULT 'user') for every path
--     that does not pass the new params.
--   - The immutability triggers (migration 017) only inspect status
--     transitions; the new columns are written during the allowed draft→posted
--     branch and never touched afterwards.
--
-- pg-test: covered-by lib/bookkeeping/__tests__/commit-actor.pg.test.ts

-- ── 1. Provenance columns on the immutable entry itself ──────────────────────

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS committed_actor_type TEXT
    CHECK (committed_actor_type IS NULL OR committed_actor_type IN (
      'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat'
    )),
  ADD COLUMN IF NOT EXISTS committed_actor_label TEXT;

COMMENT ON COLUMN public.journal_entries.committed_actor_type IS
  'WHO relayed the commit (user | api_key | mcp_oauth | cron | system | agent_chat). Complements commit_method (HOW). NULL on rows committed before this column existed or via paths that do not pass actor context.';
COMMENT ON COLUMN public.journal_entries.committed_actor_label IS
  'Human-readable credential label at commit time (e.g. API key name). Snapshot, not a foreign key.';

-- ── 2. commit_journal_entry: 4-arg → 6-arg with defaults ─────────────────────
-- DROP the exact prior signature first to avoid the PostgREST
-- "could not choose the best candidate function" overload ambiguity
-- (same consolidation technique as 20260421140000). Body copied verbatim from
-- the LATEST prior definition (20260421170500_commit_journal_entry_user_id_fallback,
-- which added the COALESCE(auth.uid(), v_entry_user_id) voucher-sequence
-- attribution for service-role callers) plus the actor additions.

DROP FUNCTION IF EXISTS public.commit_journal_entry(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.commit_journal_entry(
  p_company_id uuid,
  p_entry_id uuid,
  p_commit_method text DEFAULT NULL,
  p_rubric_version text DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE (voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
BEGIN
  -- Transaction-local actor context for write_audit_log (AFTER trigger on the
  -- UPDATE below runs in this same transaction). Empty string = unset; the
  -- trigger nullif()s it away.
  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version,
      committed_actor_type = p_actor_type,
      committed_actor_label = p_actor_label
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  RETURN QUERY SELECT v_next;
END;
$$;

-- ── 3. write_audit_log: read the actor GUCs ──────────────────────────────────
-- Verbatim copy of the latest definition (20260415000000_schema_sync.sql, 4i)
-- with ONE change: the INSERT also writes actor_type/actor_label, COALESCEing
-- an unset GUC to 'user' — today's effective DEFAULT — so every existing write
-- path produces byte-identical audit rows.

CREATE OR REPLACE FUNCTION public.write_audit_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  v_user_id := COALESCE(v_user_id, auth.uid());

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
