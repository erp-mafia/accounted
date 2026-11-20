-- A company role for people who only invoice: 'invoicer', shown as "Fakturering".
-- pg-test: tests/pg/invoicer-role.pg.test.ts
--
-- WHY
-- ---
-- A company member sees every area, payroll included, and viewer is read-only
-- everywhere (crm#1014, accounted#39). A sales person who makes quotes and
-- invoices would see every colleague's pay: in the salary tables, in the
-- ledger (a salary voucher is an ordinary verifikat) and in the bank feed.
-- Hiding payroll from a member cannot hold, so this role starts from nothing
-- and is given back only what invoicing reads.
--
-- WHAT CHANGES
-- ------------
-- 1. company_members.role and company_invitations.role admit 'invoicer'.
-- 2. The shared membership checks leave the role out, so every policy and
--    definer function built on them refuses it by default:
--      user_company_ids()            (read policies, storage, caller_is_company_member)
--      current_user_can_write()      (write policies)
--      caller_can_write_company()    (enforce_company_writer_role triggers, commit RPCs)
--    Existing roles get exactly the rows they got before: the only change is
--    an extra `role <> 'invoicer'` that no existing row matches.
-- 3. invoicer_company_ids(): the non-archived companies where the caller is
--    an invoicer. Read policies for that role only, on the tables the
--    invoicing pages read straight from the browser: invoices, invoice_items,
--    customers, articles, sales_orders, sales_order_items, fiscal_periods and
--    company_settings (the company's own bankgiro, IBAN and invoice texts),
--    plus the company row and the caller's own membership row so the app can
--    resolve the company. Nothing else: payroll, journal entries and lines,
--    bank transactions, cash accounts (balances), documents and AGI stay at
--    zero rows. The role writes nothing through PostgREST: the app writes for
--    it through a company-scoped service client (lib/auth/invoicer).
-- 4. Definer functions that check membership themselves, without the shared
--    helpers, and write where no writer trigger stops the role: the register
--    import undo, the collections batch removal and the three customer merge
--    functions. Each is copied in full from its newest migration with one
--    edit to the membership check. The definer functions that write the
--    ledger, the bank or invoices (counterparty setoffs, match_batch_allocate,
--    commit_journal_entry and the rest) already refuse the role: their
--    tables carry enforce_company_writer_role, which asks
--    caller_can_write_company(), and most check it themselves too.
-- 5. webhooks' read policy matched any membership row; it now leaves the
--    role out too.
--
-- Not touched: current_active_company_id() and resolve_active_company*()
-- still resolve the invoicer's company (the app needs it, and every write
-- policy pairs the active company with current_user_can_write()).

-- =============================================================================
-- 1. The role value
-- =============================================================================
ALTER TABLE public.company_members DROP CONSTRAINT company_members_role_check;
ALTER TABLE public.company_members ADD CONSTRAINT company_members_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'invoicer'));

ALTER TABLE public.company_invitations DROP CONSTRAINT company_invitations_role_check;
ALTER TABLE public.company_invitations ADD CONSTRAINT company_invitations_role_check
  CHECK (role IN ('admin', 'member', 'viewer', 'invoicer'));

-- =============================================================================
-- 2. Shared membership checks leave the role out
-- =============================================================================
CREATE OR REPLACE FUNCTION public.user_company_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT cm.company_id
  FROM public.company_members cm
  JOIN public.companies c ON c.id = cm.company_id
  WHERE cm.user_id = auth.uid()
    AND cm.role <> 'invoicer'
    AND c.archived_at IS NULL;
$function$;

CREATE OR REPLACE FUNCTION public.current_user_can_write()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = public.current_active_company_id()
      AND cm.role NOT IN ('viewer', 'invoicer')
  );
$function$;

CREATE OR REPLACE FUNCTION public.caller_can_write_company(p_company_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  -- No archived_at filter here: archived companies are already frozen by the
  -- migration-reset triggers, which must keep producing their own message.
  SELECT p_company_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = p_company_id
      AND cm.role NOT IN ('viewer', 'invoicer')
  );
$function$;

-- =============================================================================
-- 3. What the role may read
-- =============================================================================
CREATE FUNCTION public.invoicer_company_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT cm.company_id
  FROM public.company_members cm
  JOIN public.companies c ON c.id = cm.company_id
  WHERE cm.user_id = auth.uid()
    AND cm.role = 'invoicer'
    AND c.archived_at IS NULL;
$function$;

REVOKE ALL ON FUNCTION public.invoicer_company_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoicer_company_ids() TO authenticated, service_role;

CREATE POLICY invoices_select_invoicer ON public.invoices
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY invoice_items_select_invoicer ON public.invoice_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.company_id IN (SELECT public.invoicer_company_ids())
  ));

CREATE POLICY customers_select_invoicer ON public.customers
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY articles_select_invoicer ON public.articles
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY sales_orders_select_invoicer ON public.sales_orders
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY sales_order_items_select_invoicer ON public.sales_order_items
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY fiscal_periods_select_invoicer ON public.fiscal_periods
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY company_settings_select_invoicer ON public.company_settings
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY companies_select_invoicer ON public.companies
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.invoicer_company_ids()));

CREATE POLICY company_members_select_invoicer_self ON public.company_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND company_id IN (SELECT public.invoicer_company_ids()));

-- =============================================================================
-- 4. Definer functions with their own membership check
-- =============================================================================
-- undo_register_import: copied from 20261004163415_register_import_runs.sql, one edit: the membership
-- check also leaves the invoicer out.
CREATE OR REPLACE FUNCTION public.undo_register_import(
  p_company_id uuid,
  p_run_id     uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 -- Same budget as undo_bank_file_import: the caller runs this on the
 -- service client, the authenticated role's 8s limit does not apply.
 SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_actor      uuid;
  v_run        public.register_import_runs%ROWTYPE;
  v_table      regclass;
  v_present    uuid[];
  v_fk         record;
  v_hits       uuid[];
  v_ref_pairs  jsonb := '[]'::jsonb;
  v_referenced uuid[];
  v_deletable  uuid[];
  v_kept       jsonb := '[]'::jsonb;
  v_deleted    integer := 0;
  v_restored   integer := 0;
  v_entry      jsonb;
  v_row_id     uuid;
  v_cols       text[];
  v_current    jsonb;
  v_updated_ids uuid[];
  v_used_pairs jsonb := '[]'::jsonb;
  v_used_by    jsonb;
  v_result     jsonb;
BEGIN
  -- Actor: p_user_id is honored only for the service role (the server's
  -- cookieless client, auth.uid() NULL); every other caller is pinned to its
  -- own auth.uid(). Same gate as undo_bank_file_import, but any writer may
  -- undo, as any writer may run the import and delete the rows by hand. An
  -- archived company is refused like a non-member: user_company_ids() leaves
  -- it out of every other path, and this one is reachable as a direct RPC.
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members cm
      JOIN public.companies c ON c.id = cm.company_id
     WHERE cm.company_id = p_company_id
       AND cm.user_id = v_actor
       AND cm.role NOT IN ('viewer', 'invoicer')
       AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'undo_register_import: no write access to company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Lock the run: a second undo of the same run waits here and then sees it
  -- undone.
  SELECT * INTO v_run
    FROM public.register_import_runs
   WHERE id = p_run_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'undo_register_import: run % not found', p_run_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_run.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'undo_register_import: run % is already undone', p_run_id
      USING ERRCODE = '55000';
  END IF;

  v_table := CASE v_run.kind
    WHEN 'customers' THEN 'public.customers'::regclass
    WHEN 'suppliers' THEN 'public.suppliers'::regclass
    WHEN 'articles'  THEN 'public.articles'::regclass
  END;

  -- The created rows that still exist, locked: an insert that would start
  -- referencing one (an invoice for the customer) takes a key-share lock on
  -- it and waits for this transaction, so nothing can start using a row
  -- between the check and the delete.
  EXECUTE format(
    'SELECT coalesce(array_agg(id), ''{}'') FROM (
       SELECT id FROM %s WHERE company_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE
     ) locked',
    v_table
  ) INTO v_present USING p_company_id, v_run.created_ids;

  -- Every foreign key pointing at the register table, read from the
  -- catalog, joined on all of its columns (composite keys included).
  FOR v_fk IN
    SELECT
      (SELECT relname FROM pg_class WHERE oid = c.conrelid) AS referrer,
      c.conrelid::regclass AS referrer_table,
      (SELECT string_agg(format('r.%I = t.%I', ra.attname, ta.attname), ' AND ' ORDER BY k.ord)
         FROM unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(ref_att, tgt_att, ord)
         JOIN pg_attribute ra ON ra.attrelid = c.conrelid AND ra.attnum = k.ref_att
         JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.tgt_att) AS join_cond
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = v_table
    ORDER BY 1
  LOOP
    EXECUTE format(
      'SELECT coalesce(array_agg(DISTINCT t.id), ''{}'') FROM %s t JOIN %s r ON %s WHERE t.id = ANY($1)',
      v_table, v_fk.referrer_table, v_fk.join_cond
    ) INTO v_hits USING v_present;

    SELECT v_ref_pairs || coalesce(jsonb_agg(jsonb_build_object('id', h, 'by', v_fk.referrer)), '[]'::jsonb)
      INTO v_ref_pairs
      FROM unnest(v_hits) AS h;
  END LOOP;

  v_referenced := ARRAY(SELECT DISTINCT (e->>'id')::uuid FROM jsonb_array_elements(v_ref_pairs) e);
  v_deletable := ARRAY(SELECT unnest(v_present) EXCEPT SELECT unnest(v_referenced));

  EXECUTE format(
    'SELECT coalesce(jsonb_agg(jsonb_build_object(
        ''id'', t.id,
        ''name'', t.name,
        ''reason'', ''referenced'',
        ''referenced_by'', (SELECT jsonb_agg(DISTINCT e->>''by'') FROM jsonb_array_elements($2) e WHERE (e->>''id'')::uuid = t.id)
      ) ORDER BY t.name, t.id), ''[]''::jsonb)
       FROM %s t WHERE t.id = ANY($1)',
    v_table
  ) INTO v_kept USING v_referenced, v_ref_pairs;

  EXECUTE format(
    'WITH d AS (DELETE FROM %s WHERE company_id = $1 AND id = ANY($2) RETURNING 1) SELECT count(*) FROM d',
    v_table
  ) INTO v_deleted USING p_company_id, v_deletable;

  -- Updated rows: put back the fields the import changed, unless one of
  -- them has changed since or the row has been used since. Locked first, so
  -- nothing new can start pointing at one between the check and the write.
  v_updated_ids := ARRAY(SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_run.updated_rows) e);
  EXECUTE format(
    'SELECT count(*) FROM (SELECT id FROM %s WHERE company_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE) locked',
    v_table
  ) USING p_company_id, v_updated_ids;

  -- Used since the import: a row pointing at it (any foreign key, as for
  -- the created rows) was written after the run was recorded. updated_at
  -- when the referring table has it (a draft sent after the import counts),
  -- else created_at, else any reference at all.
  FOR v_fk IN
    SELECT
      (SELECT relname FROM pg_class WHERE oid = c.conrelid) AS referrer,
      c.conrelid::regclass AS referrer_table,
      (SELECT string_agg(format('r.%I = t.%I', ra.attname, ta.attname), ' AND ' ORDER BY k.ord)
         FROM unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(ref_att, tgt_att, ord)
         JOIN pg_attribute ra ON ra.attrelid = c.conrelid AND ra.attnum = k.ref_att
         JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.tgt_att) AS join_cond,
      (SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attname IN ('updated_at', 'created_at')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attname DESC LIMIT 1) AS since_col
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = v_table
    ORDER BY 1
  LOOP
    EXECUTE format(
      'SELECT coalesce(array_agg(DISTINCT t.id), ''{}'') FROM %s t JOIN %s r ON %s WHERE t.id = ANY($1) AND %s',
      v_table, v_fk.referrer_table, v_fk.join_cond,
      CASE WHEN v_fk.since_col IS NULL THEN 'true' ELSE format('r.%I > $2', v_fk.since_col) END
    ) INTO v_hits USING v_updated_ids, v_run.created_at;

    SELECT v_used_pairs || coalesce(jsonb_agg(jsonb_build_object('id', h, 'by', v_fk.referrer)), '[]'::jsonb)
      INTO v_used_pairs
      FROM unnest(v_hits) AS h;
  END LOOP;

  -- Each restore runs in its own subtransaction so a value that is now
  -- taken (a unique number reused since) keeps that one row instead of
  -- failing the whole undo.
  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_run.updated_rows) LOOP
    v_row_id := (v_entry->>'id')::uuid;
    v_cols := ARRAY(
      SELECT k
        FROM jsonb_object_keys(coalesce(v_entry->'before', '{}'::jsonb)) AS k
       WHERE k NOT IN ('id', 'company_id', 'user_id', 'created_at', 'updated_at', 'party_id')
         AND EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = v_table AND a.attname = k
              AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
         )
       ORDER BY k
    );
    CONTINUE WHEN cardinality(v_cols) = 0;

    EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE t.id = $1 AND t.company_id = $2 FOR UPDATE', v_table)
      INTO v_current USING v_row_id, p_company_id;
    -- Deleted since the import: nothing left to restore.
    CONTINUE WHEN v_current IS NULL;

    SELECT jsonb_agg(DISTINCT e->>'by') INTO v_used_by
      FROM jsonb_array_elements(v_used_pairs) e
     WHERE (e->>'id')::uuid = v_row_id;
    IF v_used_by IS NOT NULL THEN
      v_kept := v_kept || jsonb_build_array(jsonb_build_object(
        'id', v_row_id, 'name', v_current->>'name', 'reason', 'used_since_import', 'referenced_by', v_used_by));
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM unnest(v_cols) AS k WHERE v_current->k IS DISTINCT FROM v_entry->'after'->k) THEN
      v_kept := v_kept || jsonb_build_array(jsonb_build_object(
        'id', v_row_id, 'name', v_current->>'name', 'reason', 'changed_since_import'));
      CONTINUE;
    END IF;

    BEGIN
      EXECUTE format(
        'UPDATE %s t SET %s FROM jsonb_populate_record(NULL::%s, $1) r WHERE t.id = $2 AND t.company_id = $3',
        v_table,
        (SELECT string_agg(format('%I = r.%I', k, k), ', ') FROM unnest(v_cols) AS k),
        v_table
      ) USING v_entry->'before', v_row_id, p_company_id;
      v_restored := v_restored + 1;
    EXCEPTION WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation THEN
      v_kept := v_kept || jsonb_build_array(jsonb_build_object(
        'id', v_row_id, 'name', v_current->>'name', 'reason', 'conflict'));
    END;
  END LOOP;

  v_result := jsonb_build_object('deleted', v_deleted, 'restored', v_restored, 'kept', v_kept);

  UPDATE public.register_import_runs
     SET undone_at = now(), undone_by = v_actor, undo_result = v_result
   WHERE id = p_run_id;

  -- Behandlingshistorik: one summary row per kind of change, named for what
  -- happened (customers carry no per-row audit trigger, so without it the
  -- undo would leave no trace of who removed or restored what). Counts
  -- only: the rows themselves are not copied into the log. When every row
  -- was kept, the only change is the run being marked undone, and that is
  -- what the row says.
  IF v_deleted > 0 THEN
    INSERT INTO public.audit_log (
      user_id, company_id, action, table_name, record_id, actor_id,
      old_state, new_state, description
    ) VALUES (
      v_actor, p_company_id, 'DELETE', v_run.kind, p_run_id, v_actor,
      jsonb_build_object('register_import_run_id', p_run_id, 'created', cardinality(v_run.created_ids)),
      jsonb_build_object('deleted', v_deleted, 'kept', jsonb_array_length(v_kept)),
      'Register import undone: created rows nothing references deleted'
    );
  END IF;
  IF v_restored > 0 THEN
    INSERT INTO public.audit_log (
      user_id, company_id, action, table_name, record_id, actor_id,
      old_state, new_state, description
    ) VALUES (
      v_actor, p_company_id, 'UPDATE', v_run.kind, p_run_id, v_actor,
      jsonb_build_object('register_import_run_id', p_run_id, 'updated', jsonb_array_length(v_run.updated_rows)),
      jsonb_build_object('restored', v_restored, 'kept', jsonb_array_length(v_kept)),
      'Register import undone: fields the import changed restored on updated rows'
    );
  END IF;
  IF v_deleted = 0 AND v_restored = 0 THEN
    INSERT INTO public.audit_log (
      user_id, company_id, action, table_name, record_id, actor_id,
      old_state, new_state, description
    ) VALUES (
      v_actor, p_company_id, 'UPDATE', 'register_import_runs', p_run_id, v_actor,
      jsonb_build_object('register_import_run_id', p_run_id, 'created', cardinality(v_run.created_ids)),
      jsonb_build_object('deleted', 0, 'kept', jsonb_array_length(v_kept)),
      'Register import undone: nothing deleted, every row is in use'
    );
  END IF;

  RETURN v_result;
END;
$function$;

-- remove_collection_batch_items: copied from 20261012030600_collection_daily_batch.sql, one edit: the membership
-- check also leaves the invoicer out.
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
     OR NOT EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = v_op.company_id AND cm.user_id = v_actor AND cm.role <> 'invoicer') THEN
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

-- customer_merge_preview: copied from 20261023003000_customer_merge.sql, one edit: the membership
-- check also leaves the invoicer out.
CREATE OR REPLACE FUNCTION public.customer_merge_preview(
  p_company_id uuid,
  p_survivor_id uuid,
  p_merged_ids uuid[],
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_ids uuid[];
  v_found uuid[];
  v_survivor public.customers%ROWTYPE;
  v_card public.customers%ROWTYPE;
  v_survivor_org text;
  v_survivor_vat text;
  v_key text;
  v_merged jsonb := '[]'::jsonb;
  v_invoices int;
  v_orders int;
  v_schedules int;
  v_deadlines int;
  v_sources int;
  v_total_invoices int := 0;
  v_total_orders int := 0;
  v_total_schedules int := 0;
  v_total_deadlines int := 0;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role NOT IN ('viewer', 'invoicer')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_FORBIDDEN');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_ids
    FROM unnest(COALESCE(p_merged_ids, '{}')) AS x WHERE x IS NOT NULL;
  IF p_survivor_id IS NULL OR cardinality(v_ids) = 0 OR cardinality(v_ids) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'details', jsonb_build_object('field', 'merged_customer_ids', 'reason', 'between_1_and_50'));
  END IF;
  IF p_survivor_id = ANY (v_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'details', jsonb_build_object('field', 'merged_customer_ids', 'reason', 'survivor_in_merged'));
  END IF;

  SELECT * INTO v_survivor FROM public.customers
    WHERE id = p_survivor_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_NOT_FOUND',
      'details', jsonb_build_object('customer_id', p_survivor_id));
  END IF;
  IF v_survivor.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_SURVIVOR_ARCHIVED',
      'details', jsonb_build_object('customer_id', p_survivor_id));
  END IF;

  SELECT COALESCE(array_agg(id), '{}') INTO v_found FROM public.customers
    WHERE company_id = p_company_id AND id = ANY (v_ids);
  IF cardinality(v_found) <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_NOT_FOUND',
      'details', jsonb_build_object('customer_ids',
        (SELECT to_jsonb(array_agg(x)) FROM unnest(v_ids) AS x WHERE NOT (x = ANY (v_found)))));
  END IF;

  -- An org number keys by its letters and digits, a 12-digit form by its
  -- last 10 (lib/invariants/org-number.ts orgNumberKey); a VAT number by its
  -- letters and digits, upper case.
  v_survivor_org := NULLIF(upper(regexp_replace(COALESCE(v_survivor.org_number, ''), '[^0-9A-Za-z]', '', 'g')), '');
  IF v_survivor_org ~ '^[0-9]{12}$' THEN v_survivor_org := right(v_survivor_org, 10); END IF;
  v_survivor_vat := NULLIF(upper(regexp_replace(COALESCE(v_survivor.vat_number, ''), '[^0-9A-Za-z]', '', 'g')), '');

  FOR v_card IN SELECT * FROM public.customers
      WHERE company_id = p_company_id AND id = ANY (v_ids) ORDER BY created_at, id LOOP
    v_key := NULLIF(upper(regexp_replace(COALESCE(v_card.org_number, ''), '[^0-9A-Za-z]', '', 'g')), '');
    IF v_key ~ '^[0-9]{12}$' THEN v_key := right(v_key, 10); END IF;
    IF v_survivor_org IS NOT NULL AND v_key IS NOT NULL AND v_key <> v_survivor_org THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_IDENTITY_CONFLICT',
        'details', jsonb_build_object('customer_id', v_card.id, 'field', 'org_number'));
    END IF;
    v_key := NULLIF(upper(regexp_replace(COALESCE(v_card.vat_number, ''), '[^0-9A-Za-z]', '', 'g')), '');
    IF v_survivor_vat IS NOT NULL AND v_key IS NOT NULL AND v_key <> v_survivor_vat THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_IDENTITY_CONFLICT',
        'details', jsonb_build_object('customer_id', v_card.id, 'field', 'vat_number'));
    END IF;

    SELECT count(*) INTO v_invoices FROM public.invoices WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_orders FROM public.sales_orders WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_schedules FROM public.recurring_invoice_schedules
      WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_deadlines FROM public.deadlines WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_sources FROM public.migration_source_records
      WHERE company_id = p_company_id AND resource = 'customers' AND target_id = v_card.id;

    v_merged := v_merged || jsonb_build_array(jsonb_build_object(
      'customer_id', v_card.id,
      'name', v_card.name,
      'customer_number', v_card.customer_number,
      'merge_id', NULL,
      'was_archived', v_card.archived_at IS NOT NULL,
      'invoices', v_invoices,
      'sales_orders', v_orders,
      'recurring_invoice_schedules', v_schedules,
      'deadlines', v_deadlines,
      'source_records', v_sources));
    v_total_invoices := v_total_invoices + v_invoices;
    v_total_orders := v_total_orders + v_orders;
    v_total_schedules := v_total_schedules + v_schedules;
    v_total_deadlines := v_total_deadlines + v_deadlines;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', true,
    'survivor', jsonb_build_object('customer_id', v_survivor.id, 'name', v_survivor.name,
      'customer_number', v_survivor.customer_number),
    'merged', v_merged,
    'totals', jsonb_build_object('invoices', v_total_invoices, 'sales_orders', v_total_orders,
      'recurring_invoice_schedules', v_total_schedules, 'deadlines', v_total_deadlines));
END;
$function$;

-- merge_customers: copied from 20261023003000_customer_merge.sql, one edit: the membership
-- check also leaves the invoicer out.
CREATE OR REPLACE FUNCTION public.merge_customers(
  p_company_id uuid,
  p_survivor_id uuid,
  p_merged_ids uuid[],
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_check jsonb;
  v_survivor public.customers%ROWTYPE;
  v_card public.customers%ROWTYPE;
  v_invoices uuid[];
  v_orders uuid[];
  v_schedules uuid[];
  v_deadlines uuid[];
  v_sources uuid[];
  v_merge_id uuid;
  v_merged jsonb := '[]'::jsonb;
  v_total_invoices int := 0;
  v_total_orders int := 0;
  v_total_schedules int := 0;
  v_total_deadlines int := 0;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role NOT IN ('viewer', 'invoicer')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_FORBIDDEN');
  END IF;

  -- Every card of the merge, locked in id order so two merges never wait on
  -- each other crosswise. FOR UPDATE also holds off an invoice, order or
  -- deadline written against a duplicate while it moves (an FK check takes
  -- FOR KEY SHARE on the card). Then the rules, on the locked rows.
  PERFORM 1 FROM public.customers
    WHERE company_id = p_company_id
      AND (id = p_survivor_id OR id = ANY (COALESCE(p_merged_ids, '{}')))
    ORDER BY id FOR UPDATE;
  v_check := public.customer_merge_preview(p_company_id, p_survivor_id, p_merged_ids, p_user_id);
  IF NOT (v_check->>'ok')::boolean THEN
    RETURN v_check;
  END IF;

  SELECT * INTO v_survivor FROM public.customers WHERE id = p_survivor_id AND company_id = p_company_id;

  FOR v_card IN SELECT c.* FROM public.customers c
      WHERE c.company_id = p_company_id
        AND c.id IN (SELECT (m->>'customer_id')::uuid FROM jsonb_array_elements(v_check->'merged') AS m)
      ORDER BY c.created_at, c.id LOOP
    WITH moved AS (
      UPDATE public.invoices SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_invoices FROM moved;
    WITH moved AS (
      UPDATE public.sales_orders SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_orders FROM moved;
    WITH moved AS (
      UPDATE public.recurring_invoice_schedules SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_schedules FROM moved;
    WITH moved AS (
      UPDATE public.deadlines SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_deadlines FROM moved;
    WITH moved AS (
      UPDATE public.migration_source_records SET target_id = p_survivor_id
      WHERE company_id = p_company_id AND resource = 'customers' AND target_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_sources FROM moved;
    UPDATE public.customers SET archived_at = COALESCE(archived_at, now())
      WHERE id = v_card.id AND company_id = p_company_id;

    INSERT INTO public.customer_merges (company_id, user_id, survivor_id, merged_id, moved, merged_archived_at)
    VALUES (p_company_id, v_caller, p_survivor_id, v_card.id,
      jsonb_build_object(
        'invoices', to_jsonb(v_invoices),
        'sales_orders', to_jsonb(v_orders),
        'recurring_invoice_schedules', to_jsonb(v_schedules),
        'deadlines', to_jsonb(v_deadlines),
        'migration_source_records', to_jsonb(v_sources)),
      v_card.archived_at)
    RETURNING id INTO v_merge_id;

    v_merged := v_merged || jsonb_build_array(jsonb_build_object(
      'customer_id', v_card.id,
      'name', v_card.name,
      'customer_number', v_card.customer_number,
      'merge_id', v_merge_id,
      'was_archived', v_card.archived_at IS NOT NULL,
      'invoices', cardinality(v_invoices),
      'sales_orders', cardinality(v_orders),
      'recurring_invoice_schedules', cardinality(v_schedules),
      'deadlines', cardinality(v_deadlines),
      'source_records', cardinality(v_sources)));
    v_total_invoices := v_total_invoices + cardinality(v_invoices);
    v_total_orders := v_total_orders + cardinality(v_orders);
    v_total_schedules := v_total_schedules + cardinality(v_schedules);
    v_total_deadlines := v_total_deadlines + cardinality(v_deadlines);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'survivor', jsonb_build_object('customer_id', v_survivor.id, 'name', v_survivor.name,
      'customer_number', v_survivor.customer_number),
    'merged', v_merged,
    'totals', jsonb_build_object('invoices', v_total_invoices, 'sales_orders', v_total_orders,
      'recurring_invoice_schedules', v_total_schedules, 'deadlines', v_total_deadlines));
END;
$function$;

-- undo_customer_merge: copied from 20261023003000_customer_merge.sql, one edit: the membership
-- check also leaves the invoicer out.
CREATE OR REPLACE FUNCTION public.undo_customer_merge(
  p_company_id uuid,
  p_merge_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_m public.customer_merges%ROWTYPE;
  v_invoices int;
  v_orders int;
  v_schedules int;
  v_deadlines int;
  v_sources int;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role NOT IN ('viewer', 'invoicer')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_FORBIDDEN');
  END IF;

  SELECT * INTO v_m FROM public.customer_merges
    WHERE id = p_merge_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_NOT_FOUND',
      'details', jsonb_build_object('merge_id', p_merge_id));
  END IF;
  IF v_m.undone_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_ALREADY_UNDONE',
      'details', jsonb_build_object('merge_id', p_merge_id));
  END IF;
  IF v_m.created_at < now() - interval '30 days' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_UNDO_EXPIRED',
      'details', jsonb_build_object('merge_id', p_merge_id));
  END IF;

  PERFORM 1 FROM public.customers
    WHERE company_id = p_company_id AND id IN (v_m.survivor_id, v_m.merged_id)
    ORDER BY id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.customer_merges l
             WHERE l.company_id = p_company_id AND l.merged_id = v_m.survivor_id
               AND l.undone_at IS NULL AND l.created_at >= v_m.created_at) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_UNDO_BLOCKED',
      'details', jsonb_build_object('merge_id', p_merge_id, 'customer_id', v_m.survivor_id));
  END IF;

  -- Only the rows this merge moved, and only while they still name the
  -- survivor: a row moved on since stays where it was put.
  WITH r AS (
    UPDATE public.invoices SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'invoices') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_invoices FROM r;
  WITH r AS (
    UPDATE public.sales_orders SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'sales_orders') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_orders FROM r;
  WITH r AS (
    UPDATE public.recurring_invoice_schedules SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'recurring_invoice_schedules') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_schedules FROM r;
  WITH r AS (
    UPDATE public.deadlines SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'deadlines') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_deadlines FROM r;
  WITH r AS (
    UPDATE public.migration_source_records SET target_id = v_m.merged_id
    WHERE company_id = p_company_id AND resource = 'customers' AND target_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'migration_source_records') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_sources FROM r;

  UPDATE public.customers SET archived_at = v_m.merged_archived_at
    WHERE id = v_m.merged_id AND company_id = p_company_id;
  UPDATE public.customer_merges SET undone_at = now(), undone_by = v_caller WHERE id = v_m.id;

  RETURN jsonb_build_object(
    'ok', true,
    'merge_id', v_m.id,
    'survivor_customer_id', v_m.survivor_id,
    'restored_customer_id', v_m.merged_id,
    'restored', jsonb_build_object('invoices', v_invoices, 'sales_orders', v_orders,
      'recurring_invoice_schedules', v_schedules, 'deadlines', v_deadlines, 'source_records', v_sources));
END;
$function$;

-- =============================================================================
-- 5. webhooks: the read policy matched any membership row
-- =============================================================================
DROP POLICY "Members can view company webhooks" ON public.webhooks;
CREATE POLICY "Members can view company webhooks" ON public.webhooks
  FOR SELECT
  USING (company_id IN (
    SELECT company_members.company_id
    FROM public.company_members
    WHERE company_members.user_id = auth.uid()
      AND company_members.role <> 'invoicer'
  ));

NOTIFY pgrst, 'reload schema';
