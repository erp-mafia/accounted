-- bulk_book_transactions: hand commit method and actor on to the commit.
--
-- A samlingsverifikat booked through this function recorded neither WHO
-- committed it nor HOW: the function called the two-argument form
-- commit_journal_entry(p_company_id, v_journal_entry_id), so
-- journal_entries.commit_method and committed_actor_type/_label stayed NULL
-- and the audit_log COMMIT row fell back to 'user' with no label, whichever
-- door it came through (dashboard, v1, MCP approval). commitEntry has passed
-- both since 20260619120000; this is the bank-row door catching up
-- (BFNAR 2013:2 kap 8, behandlingshistorik).
--
-- Three parameters, all DEFAULT NULL, handed positionally to the six-argument
-- commit_journal_entry (p_rubric_version stays NULL, as before). A caller that
-- passes none commits exactly as before. The values carry no more trust than
-- they do on commit_journal_entry itself, which authenticated already
-- executes with the same parameters; the column CHECKs bound them.
--
-- Edited in place, not redefined from a file: no migration holds this body
-- whole (see 20261010200000). Each marker must occur exactly once, or the
-- migration refuses instead of rewriting a body it does not recognise. A new
-- parameter list is a new function, so the five-argument one is dropped (one
-- candidate for PostgREST, and five-argument call sites resolve through the
-- defaults); its comment is carried over and the grants are re-asserted,
-- because DROP discards both.
--
-- pg-test: tests/pg/bulk-book-commit-attribution.pg.test.ts

DO $migration$
DECLARE
  v_definition text := replace(
    pg_get_functiondef('public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)'::regprocedure),
    E'\r\n', E'\n');
  v_comment text := obj_description(
    'public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)'::regprocedure, 'pg_proc');
  v_edit record;
  v_count integer;
BEGIN
  FOR v_edit IN
    SELECT replace(old_text, E'\r\n', E'\n') AS old_text,
           replace(new_text, E'\r\n', E'\n') AS new_text
    FROM (VALUES
      -- 1. The parameter list.
      ($old$p_user_id uuid DEFAULT NULL::uuid)$old$,
       $new$p_user_id uuid DEFAULT NULL::uuid, p_commit_method text DEFAULT NULL::text, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)$new$),
      -- 2. The commit.
      ($old$    FROM public.commit_journal_entry(p_company_id, v_journal_entry_id);
$old$,
       $new$    FROM public.commit_journal_entry(
      p_company_id, v_journal_entry_id, p_commit_method, NULL, p_actor_type, p_actor_label);
$new$)
    ) AS edits(old_text, new_text)
  LOOP
    v_count := (length(v_definition) - length(replace(v_definition, v_edit.old_text, ''))) / length(v_edit.old_text);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Unexpected bulk_book_transactions definition: % occurrence(s) of the marker %',
        v_count, quote_literal(v_edit.old_text);
    END IF;
    v_definition := replace(v_definition, v_edit.old_text, v_edit.new_text);
  END LOOP;

  DROP FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid, uuid);
  EXECUTE v_definition;
  EXECUTE format(
    'COMMENT ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid, uuid, text, text, text) IS %L',
    concat_ws(' ', v_comment,
      'p_commit_method, p_actor_type and p_actor_label are handed to commit_journal_entry, which stamps them on the verifikat and its audit_log COMMIT row (20261011140000).'));
END;
$migration$;

-- Default privileges hand new functions to anon as well, so PUBLIC and anon
-- are revoked explicitly, as 20260824170000 does.
REVOKE ALL ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid, uuid, text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
