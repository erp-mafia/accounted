-- Undo a customer, supplier or article import (register import).
--
-- A user reported there was no way back from a register import. The three
-- execute routes (api/import/{customers,suppliers,articles}/execute) insert
-- row by row and kept no record of a run, so nothing knew which rows a file
-- had created: the only way back was deleting rows one at a time.
--
-- 1. register_import_runs: one row per import, written by the execute route
--    after the import, holding the ids it created and, for every existing
--    row it merge-updated, the fields it changed (before and after).
--    Readable by the company, insertable by a writer for themself, never
--    updated or deleted by a client: the only later write is the undo below.
--
-- 2. undo_register_import RPC: deletes the created rows that nothing
--    references, keeps the rest and says why, and marks the run undone.
--    "Referenced" is read from the catalog, not from a hand-kept list: every
--    foreign key that points at the register table counts (today invoices,
--    invoice rows, sales orders and their rows, recurring schedules,
--    deadlines, supplier invoices and the invoice inbox; any key added later
--    counts automatically). Several of those keys are ON DELETE SET NULL, so
--    a plain DELETE would quietly strip a customer from its invoices; a used
--    row is kept whatever its key's delete action. The check runs as the
--    definer so a row hidden from the caller by RLS still counts as a use.
--
--    Updated rows get the changed fields back, unless one of those fields
--    has changed again since the import, or something has used the row
--    since (a row pointing at it, through any foreign key, was created or
--    updated after the import: an invoice issued to the customer names it
--    with the imported details, so those details stay). Such rows are kept
--    as they are and reported: the undo takes back what the import did,
--    never what someone did afterwards. Fields the import did not touch are
--    never written.
--    Only real, user-editable columns are restored; the snapshot is client
--    input, so id, company, owner, timestamps and the party link (the role
--    trigger re-derives it from the restored org number) are skipped.
--
-- Party rows that the role-link trigger (link_party_on_role_write) created
-- for imported customers and suppliers stay, as they do after the regular
-- customer and supplier delete: a party without a role is not listed in
-- Kunder or Leverantörer, and a re-import with the same org number links
-- back to it (ensure_party finds it) instead of creating a duplicate.
--
-- Runs recorded before this migration do not exist: imports made earlier
-- cannot be undone, there is no reliable way to tell which rows they made.

CREATE TABLE public.register_import_runs (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('customers', 'suppliers', 'articles')),
  created_ids   uuid[] NOT NULL DEFAULT '{}',
  created_count integer GENERATED ALWAYS AS (cardinality(created_ids)) STORED,
  -- [{id, before: {field: value}, after: {field: value}}], changed fields only.
  updated_rows  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(updated_rows) = 'array'),
  updated_count integer GENERATED ALWAYS AS (jsonb_array_length(updated_rows)) STORED,
  undone_at     timestamptz,
  undone_by     uuid REFERENCES auth.users(id),
  -- {deleted, restored, kept: [{id, name, reason, referenced_by}]}, written by the undo.
  undo_result   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT register_import_runs_undo_complete
    CHECK ((undone_at IS NULL) = (undo_result IS NULL) AND (undone_at IS NULL) = (undone_by IS NULL))
);

COMMENT ON TABLE public.register_import_runs IS
  'One row per customer/supplier/article register import from the dashboard: what it created, so undo_register_import can take it back. Written by the execute routes; only the undo RPC changes a row afterwards.';

ALTER TABLE public.register_import_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.register_import_runs TO service_role;
-- authenticated reads and records runs; undo goes through the RPC, so there
-- is no UPDATE or DELETE grant and no policy for them.
GRANT SELECT, INSERT ON TABLE public.register_import_runs TO authenticated;

CREATE POLICY "view own-company register_import_runs"
  ON public.register_import_runs FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "insert own register_import_runs"
  ON public.register_import_runs FOR INSERT
  WITH CHECK (
    company_id IN (SELECT user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND user_id = auth.uid()
    AND undone_at IS NULL
  );

CREATE INDEX idx_register_import_runs_company_created
  ON public.register_import_runs (company_id, created_at DESC);

CREATE TRIGGER set_updated_at_register_import_runs
  BEFORE UPDATE ON public.register_import_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- No per-row audit trigger: the run is itself the record of the import, and
-- the undo writes one summary row to audit_log (same shape as
-- undo_bank_file_import) without copying register data into the immutable log.

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
       AND cm.role <> 'viewer'
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

REVOKE EXECUTE ON FUNCTION public.undo_register_import(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_register_import(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.undo_register_import(uuid, uuid, uuid) IS
  'Undoes a register import run: deletes the created rows no foreign key references, restores the fields it changed on updated rows unless they changed since, keeps and reports the rest, marks the run undone. Requires the actor to be a non-viewer member of p_company_id; p_user_id is honored only for service_role callers. Raises 42501 (no access), P0002 (no such run), 55000 (already undone).';

NOTIFY pgrst, 'reload schema';
