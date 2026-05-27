-- Fix actor attribution on enforce_document_metadata_immutability blocked-write audits.
--
-- The trigger introduced in 20260527130000 records SECURITY_EVENT rows when a
-- caller attempts a forbidden mutation on a posted document. Both inserts
-- assigned the existing OLD.user_id (the document's owner) to audit_log.user_id
-- and left actor_id NULL. That means the trail names the victim — not the
-- attacker — as the actor for any blocked tampering attempt, which is the
-- opposite of what an incident reviewer needs.
--
-- Fix: capture auth.uid() into a local at the top of the trigger and write it
-- to actor_id on every SECURITY_EVENT insert. We keep user_id = OLD.user_id
-- (document owner) so the affected resource is still discoverable by owner,
-- while actor_id identifies the session that triggered the blocked write.
-- auth.uid() can be NULL in service-role / cron contexts, so the column is
-- nullable already and a NULL actor_id correctly signals "non-user origin".

CREATE OR REPLACE FUNCTION public.enforce_document_metadata_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_status text;
  v_allow_supersede boolean;
  v_actor uuid := auth.uid();
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  v_allow_supersede := current_setting('gnubok.allow_supersede', true) = 'true';

  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_entry_status
  FROM public.journal_entries
  WHERE id = OLD.journal_entry_id;

  IF v_entry_status IS NULL OR v_entry_status NOT IN ('posted', 'reversed') THEN
    RETURN NEW;
  END IF;

  -- Even with allow_supersede, every field other than is_current_version and
  -- superseded_by_id remains immutable. The bypass is intentionally narrow
  -- so that a session that obtains the GUC (e.g. via SQL injection) cannot
  -- mutate journal_entry_id, sha256_hash, storage_path, or any other field
  -- the BFL 7 kap audit trail depends on.
  IF NEW.file_name              IS DISTINCT FROM OLD.file_name
     OR NEW.storage_path        IS DISTINCT FROM OLD.storage_path
     OR NEW.file_size_bytes     IS DISTINCT FROM OLD.file_size_bytes
     OR NEW.mime_type           IS DISTINCT FROM OLD.mime_type
     OR NEW.sha256_hash         IS DISTINCT FROM OLD.sha256_hash
     OR NEW.upload_source       IS DISTINCT FROM OLD.upload_source
     OR NEW.digitization_date   IS DISTINCT FROM OLD.digitization_date
     OR NEW.uploaded_by         IS DISTINCT FROM OLD.uploaded_by
     OR NEW.version             IS DISTINCT FROM OLD.version
     OR NEW.original_id         IS DISTINCT FROM OLD.original_id
     OR NEW.journal_entry_id    IS DISTINCT FROM OLD.journal_entry_id
     OR NEW.journal_entry_line_id IS DISTINCT FROM OLD.journal_entry_line_id
  THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'SECURITY_EVENT', 'document_attachments', OLD.id, v_actor,
      'Blocked metadata or link modification of document linked to ' || v_entry_status || ' entry ' || OLD.journal_entry_id);

    RAISE EXCEPTION 'Cannot modify metadata or journal entry link of document linked to a % journal entry (BFL 7 kap)', v_entry_status;
  END IF;

  -- is_current_version and superseded_by_id may only be changed under the
  -- supersede GUC. Without it, those flips are also blocked.
  IF NOT v_allow_supersede
     AND (NEW.is_current_version IS DISTINCT FROM OLD.is_current_version
          OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id)
  THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'SECURITY_EVENT', 'document_attachments', OLD.id, v_actor,
      'Blocked is_current_version/superseded_by_id flip without supersede GUC on document linked to ' || v_entry_status || ' entry ' || OLD.journal_entry_id);

    RAISE EXCEPTION 'Cannot modify is_current_version of document linked to a % journal entry without supersede GUC (BFL 7 kap)', v_entry_status;
  END IF;

  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
