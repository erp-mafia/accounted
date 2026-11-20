-- The daily reminder batch (accounted#104, phase 2): once a day the reminder
-- cron (src/app/api/reminders/batch/cron/route.ts) gathers the reminders due
-- for a company that turned reminders on into ONE staged pending operation,
-- reminder_daily_batch, which an owner or administrator reviews and approves
-- in the web UI. Nothing is sent before that approval, and every item is
-- decided again at the send (src/lib/reminders/dispatch.ts).
--
-- Modelled on the daily collections batch (20261012030600), and reusing its
-- removals:
--   1. reminder_daily_batch in the pending_operations type CHECK, expanded
--      from the constraint's current definition (the 20261026230100
--      pattern), NOT VALID; the VALIDATE runs in 20261027120200.
--   2. One pending batch per company, and one batch per company and day
--      (whatever became of it), as unique partial indexes, so two cron runs
--      racing each other cannot stage twice.
--   3. Only the system stages a batch, never a member through the API. Once
--      staged, its params are frozen like every staged operation's
--      (enforce_pending_operations_input_frozen).
--   4. "Bocka ur dem du inte vill skicka" goes through the collections
--      batch's removals: collection_batch_removals accepts the item kind
--      'reminder', and remove_collection_batch_items accepts a reminder
--      batch (same rules: owner or administrator, pending only, the last
--      item stays, an audit_log row naming the person).
--
-- pg-test: tests/pg/reminder-daily-batch.pg.test.ts,
--          tests/pg/pending-operations-op-type-audit.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. pending_operations.operation_type: reminder_daily_batch
-- =============================================================================

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
  FOREACH v_new IN ARRAY ARRAY['reminder_daily_batch'] LOOP
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

-- =============================================================================
-- 2. One pending batch per company; one batch per company and day
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS pending_operations_reminder_batch_pending_uniq
  ON public.pending_operations (company_id)
  WHERE operation_type = 'reminder_daily_batch' AND status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS pending_operations_reminder_batch_day_uniq
  ON public.pending_operations (company_id, (params ->> 'batch_date'))
  WHERE operation_type = 'reminder_daily_batch';

-- =============================================================================
-- 3. Staged by the system only
-- =============================================================================

-- SECURITY INVOKER on purpose: current_user is the role that wrote the row.
-- The reminder cron stages with the service role.
CREATE OR REPLACE FUNCTION public.guard_reminder_batch_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') OR COALESCE(auth.role(), '') IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'REMINDER_BATCH_SYSTEM_ONLY: a reminder batch is staged by Accounted only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_reminder_batch_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_reminder_batch_insert ON public.pending_operations;
CREATE TRIGGER guard_reminder_batch_insert
  BEFORE INSERT ON public.pending_operations
  FOR EACH ROW
  WHEN (NEW.operation_type = 'reminder_daily_batch')
  EXECUTE FUNCTION public.guard_reminder_batch_insert();

-- =============================================================================
-- 4. Removals: the collections batch's table and function, for reminders too
-- =============================================================================

ALTER TABLE public.collection_batch_removals
  DROP CONSTRAINT IF EXISTS collection_batch_removals_kind_check;
ALTER TABLE public.collection_batch_removals
  ADD CONSTRAINT collection_batch_removals_kind_check
  CHECK (kind IN ('open', 'start', 'approve_step', 'reminder'));

COMMENT ON TABLE public.collection_batch_removals IS
  'Items an owner or administrator took out of a pending daily batch (collections or reminders) before approving it. Append-only; written by remove_collection_batch_items only.';

-- Unchanged from 20261012030600 but for the batch types it accepts and the
-- audit text naming which batch.
CREATE OR REPLACE FUNCTION public.remove_collection_batch_items(p_operation_id uuid, p_invoice_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_op record;
  v_removed integer := 0;
  v_remaining integer := 0;
  v_total integer := 0;
  v_removed_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT id, company_id, operation_type, status, params
    INTO v_op
    FROM public.pending_operations
   WHERE id = p_operation_id
   FOR UPDATE;
  IF NOT FOUND OR v_op.operation_type NOT IN ('collections_daily_batch', 'reminder_daily_batch')
     OR v_actor IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = v_op.company_id AND cm.user_id = v_actor) THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_NOT_FOUND: no such daily batch' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_is_company_admin(v_op.company_id) THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_ADMIN_ONLY: only an owner or administrator changes the batch' USING ERRCODE = '42501';
  END IF;
  IF v_op.status <> 'pending' THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_NOT_PENDING: the batch is already decided' USING ERRCODE = '55000';
  END IF;

  -- The audit row names only what this call took out: not ids outside the
  -- batch, and not items an earlier call already removed.
  WITH inserted AS (
    INSERT INTO public.collection_batch_removals (company_id, pending_operation_id, invoice_id, kind, removed_by)
    SELECT DISTINCT v_op.company_id, v_op.id, (item ->> 'invoice_id')::uuid, item ->> 'kind', v_actor
      FROM jsonb_array_elements(COALESCE(v_op.params -> 'items', '[]'::jsonb)) AS item
     WHERE (item ->> 'invoice_id')::uuid = ANY (COALESCE(p_invoice_ids, ARRAY[]::uuid[]))
    ON CONFLICT ON CONSTRAINT collection_batch_removals_once DO NOTHING
    RETURNING invoice_id
  )
  SELECT count(*)::integer, COALESCE(array_agg(DISTINCT invoice_id), ARRAY[]::uuid[])
    INTO v_removed, v_removed_ids
    FROM inserted;

  SELECT count(*) INTO v_total
    FROM jsonb_array_elements(COALESCE(v_op.params -> 'items', '[]'::jsonb));
  SELECT count(*) INTO v_remaining
    FROM jsonb_array_elements(COALESCE(v_op.params -> 'items', '[]'::jsonb)) AS item
   WHERE NOT EXISTS (
     SELECT 1 FROM public.collection_batch_removals r
      WHERE r.pending_operation_id = v_op.id
        AND r.invoice_id = (item ->> 'invoice_id')::uuid
        AND r.kind = item ->> 'kind'
   );
  IF v_remaining = 0 AND v_total > 0 THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_EMPTY: at least one item must remain' USING ERRCODE = '22023';
  END IF;

  IF v_removed > 0 THEN
    INSERT INTO public.audit_log
      (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
    VALUES (
      v_actor,
      v_op.company_id,
      'UPDATE',
      'pending_operations',
      v_op.id,
      v_actor,
      jsonb_build_object('operation_type', v_op.operation_type, 'remaining', v_remaining + v_removed),
      jsonb_build_object('operation_type', v_op.operation_type, 'remaining', v_remaining,
        'removed_invoice_ids', to_jsonb(v_removed_ids)),
      'Removed ' || v_removed::text || ' item(s) from a '
        || CASE v_op.operation_type WHEN 'reminder_daily_batch' THEN 'reminder' ELSE 'collections' END || ' batch',
      COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
      nullif(current_setting('gnubok.actor_label', true), '')
    );
  END IF;

  RETURN jsonb_build_object('removed', v_removed, 'remaining', v_remaining);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_collection_batch_items(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_collection_batch_items(uuid, uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
