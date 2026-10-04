-- Undo a customer, supplier or article import (register import).
--
-- A user reported there was no way back from a register import. The three
-- execute routes (api/import/{customers,suppliers,articles}/execute) insert
-- row by row and kept no record of a run, so nothing knew which rows a file
-- had created: the only way back was deleting rows one at a time.
--
-- 1. register_import_runs: one row per import, written by the execute route
--    after the import, holding the ids it created. Readable by the company,
--    insertable by a writer for themself, never updated or deleted by a
--    client: the only later write is the undo below.
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
  undone_at     timestamptz,
  undone_by     uuid REFERENCES auth.users(id),
  -- {deleted, kept: [{id, name, reason, referenced_by}]}, written by the undo.
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

  v_result := jsonb_build_object('deleted', v_deleted, 'kept', v_kept);

  UPDATE public.register_import_runs
     SET undone_at = now(), undone_by = v_actor, undo_result = v_result
   WHERE id = p_run_id;

  -- Behandlingshistorik: a summary row named for what happened (customers
  -- carry no per-row audit trigger, so without it the undo would leave no
  -- trace of who removed what). Counts only: the rows themselves are not
  -- copied into the log. When every row was kept, the only change is the
  -- run being marked undone, and that is what the row says.
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
  ELSE
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
  'Undoes a register import run: deletes the created rows no foreign key references, keeps and reports the rest, marks the run undone. Requires the actor to be a non-viewer member of p_company_id; p_user_id is honored only for service_role callers. Raises 42501 (no access), P0002 (no such run), 55000 (already undone).';

NOTIFY pgrst, 'reload schema';
