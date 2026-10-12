-- Make a fresh replay of supabase/migrations/ build what production runs, for
-- the four objects where they still differ (read-only comparison on
-- 2026-10-11 of production against a replay of main at f0b67c917).
-- pg-test: tests/pg/prod-drift-leftovers.pg.test.ts
--
-- 1. public.create_invoice_with_items(jsonb, jsonb): exists only in
--    production; no migration ever created it (20260304191528 says so).
--    Nothing calls it, EXECUTE is service_role only since 20260901100000,
--    and it cannot work: it inserts invoices without company_id, which is
--    NOT NULL. 20260901100000 revoked it and left the drop to a migration of
--    its own (DECISIONS.md, 2026-09-01).
--
-- 2. public.update_reconciliation_session_counts(): production-only
--    SECURITY DEFINER trigger function, executable by PUBLIC, anon and
--    authenticated. No trigger uses it and no reconciliation session table
--    exists.
--
--    Neither drop uses CASCADE: if anything did depend on one of them, the
--    migration fails instead of taking the dependent object with it.
--
-- 3. public.oauth_used_codes: 20260602145425 enabled RLS and revoked every
--    privilege from anon and authenticated, and production records it as
--    applied, yet production grants both roles ALL on the table again. The
--    same two statements run again here; on a fresh replay they change
--    nothing.
--
-- 4. public.block_document_deletion(): 20260409130300_audit_all_document_deletions
--    (#209) made the guard write an audit row for every unlinked or
--    draft-linked document it lets through, and pinned search_path. It ran
--    in production, then the file left the repo when #244 squashed 22
--    migrations into 20260415000000_schema_sync, which did not carry the
--    function. A replay has run the 20260330130000 body since. The
--    definition below is production's pg_get_functiondef output byte for
--    byte (only the closing semicolon is added), so in production it changes
--    nothing: md5(pg_get_functiondef) stays 92ca7eac2c127593bb687b934621b587.
--    The trigger on document_attachments (20240101000017) is not touched.

DROP FUNCTION IF EXISTS public.create_invoice_with_items(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.update_reconciliation_session_counts();

ALTER TABLE public.oauth_used_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oauth_used_codes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_document_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_status text;
  v_retention_expires date;
BEGIN
  -- Always log document deletion attempts (linked and unlinked)
  IF OLD.journal_entry_id IS NULL THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description, old_state)
    VALUES (
      OLD.user_id, OLD.company_id, 'DELETE', 'document_attachments', OLD.id,
      'Deleted unlinked document "' || OLD.file_name || '"',
      to_jsonb(OLD)
    );
    RETURN OLD;
  END IF;

  -- Check if linked to a committed journal entry
  SELECT je.status INTO v_entry_status
  FROM public.journal_entries je
  WHERE je.id = OLD.journal_entry_id;

  IF v_entry_status IN ('posted', 'reversed') THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'DOCUMENT_DELETE_BLOCKED', 'document_attachments', OLD.id,
      'Attempted deletion of document linked to ' || v_entry_status || ' journal entry ' || OLD.journal_entry_id);

    RAISE EXCEPTION 'Cannot delete document linked to a % journal entry (Bokforingslagen)',
      v_entry_status;
  END IF;

  -- Check retention window
  SELECT fp.retention_expires_at INTO v_retention_expires
  FROM public.journal_entries je
  JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
  WHERE je.id = OLD.journal_entry_id;

  IF v_retention_expires IS NOT NULL AND v_retention_expires > CURRENT_DATE THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'RETENTION_BLOCK', 'document_attachments', OLD.id,
      'Attempted deletion within retention period (expires ' || v_retention_expires || ')');

    RAISE EXCEPTION 'Cannot delete document within 7-year retention period (expires %)',
      v_retention_expires;
  END IF;

  -- Log deletion of linked-but-not-committed documents
  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description, old_state)
  VALUES (
    OLD.user_id, OLD.company_id, 'DELETE', 'document_attachments', OLD.id,
    'Deleted document "' || OLD.file_name || '" linked to draft entry ' || OLD.journal_entry_id,
    to_jsonb(OLD)
  );

  RETURN OLD;
END;
$function$
;

NOTIFY pgrst, 'reload schema';
