-- Restore document version supersession on posted entries.
--

-- Background: 20260506150000 extended enforce_document_metadata_immutability
-- to also block changes to journal_entry_id, journal_entry_line_id, AND
-- is_current_version when the document is linked to a posted/reversed entry.
-- The journal_entry_id / line_id additions are correct — they close a real
-- BFL 7 kap 2§ bypass (UPDATE journal_entry_id = NULL → DELETE).
--
-- The is_current_version addition was overreach: the create_document_version
-- RPC must flip the OLD row from is_current_version = true to false (and
-- set superseded_by_id) as part of the legitimate WORM-compliant supersession
-- flow. Every replace attempt on a doc linked to a posted verifikat now
-- raises "Cannot modify metadata or journal entry link of document linked
-- to a posted journal entry (BFL 7 kap)" — which surfaces in the Bilagor
-- modal as "Kunde inte ladda upp ny version".
--
-- This blocks the only path users have to fix corrupt underlag: a PDF that
-- was uploaded with bad bytes (e.g. via the MCP server before magic-byte
-- validation landed in 20260526) is now permanently unreadable on a posted
-- entry, with no replacement possible.
--
-- Fix: introduce a transaction-local gnubok.allow_supersede GUC. Unlike
-- gnubok.allow_delete, this is NOT a blanket bypass — the trigger continues
-- to enforce immutability on every field except is_current_version and
-- superseded_by_id even when the GUC is set. Combined with caller-identity
-- checks inside create_document_version (auth.uid() match + company
-- membership), an attacker who sets the GUC manually still cannot mutate
-- journal_entry_id, sha256_hash, storage_path, or any other audit-critical
-- field on a posted document.

CREATE OR REPLACE FUNCTION public.enforce_document_metadata_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_status text;
  v_allow_supersede boolean;
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
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'SECURITY_EVENT', 'document_attachments', OLD.id,
      'Blocked metadata or link modification of document linked to ' || v_entry_status || ' entry ' || OLD.journal_entry_id);

    RAISE EXCEPTION 'Cannot modify metadata or journal entry link of document linked to a % journal entry (BFL 7 kap)', v_entry_status;
  END IF;

  -- is_current_version and superseded_by_id may only be changed under the
  -- supersede GUC. Without it, those flips are also blocked.
  IF NOT v_allow_supersede
     AND (NEW.is_current_version IS DISTINCT FROM OLD.is_current_version
          OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id)
  THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'SECURITY_EVENT', 'document_attachments', OLD.id,
      'Blocked is_current_version/superseded_by_id flip without supersede GUC on document linked to ' || v_entry_status || ' entry ' || OLD.journal_entry_id);

    RAISE EXCEPTION 'Cannot modify is_current_version of document linked to a % journal entry without supersede GUC (BFL 7 kap)', v_entry_status;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_document_version(
  p_user_id uuid,
  p_original_doc_id uuid,
  p_storage_path text,
  p_file_name text,
  p_file_size_bytes bigint,
  p_mime_type text,
  p_sha256_hash text
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_current document_attachments%ROWTYPE;
  v_new_id uuid;
  v_root_id uuid;
  v_next_version integer;
  v_is_member boolean;
BEGIN
  -- Caller identity: the RPC is SECURITY DEFINER, so without this guard a
  -- direct PostgREST call from any authenticated user could supplant
  -- p_user_id with an arbitrary UUID. Reject any mismatch — the route layer
  -- already passes the user's own id, so a mismatch is always malicious.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required to create document version';
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'p_user_id does not match authenticated user';
  END IF;

  SELECT * INTO v_current
  FROM public.document_attachments
  WHERE id = p_original_doc_id
    AND is_current_version = true
  FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Document % not found or is not the current version', p_original_doc_id;
  END IF;

  -- Company membership: the caller must be a member of the document's
  -- company. RLS would block a direct SELECT in non-DEFINER contexts, but
  -- inside this SECURITY DEFINER function we bypass RLS and must enforce
  -- the tenant boundary ourselves.
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = v_current.company_id
      AND cm.user_id = v_caller
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    -- Audit the cross-tenant attempt so it shows up in security review.
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (v_caller, v_current.company_id, 'SECURITY_EVENT', 'document_attachments', p_original_doc_id,
      'Blocked cross-company create_document_version attempt');
    RAISE EXCEPTION 'User is not a member of the document''s company';
  END IF;

  v_root_id := COALESCE(v_current.original_id, v_current.id);
  v_next_version := v_current.version + 1;

  -- Insert new version. The supersede GUC is set *before* both DML statements
  -- so the trigger sees a consistent state across the whole supersession.
  PERFORM set_config('gnubok.allow_supersede', 'true', true);

  INSERT INTO public.document_attachments (
    user_id, company_id, storage_path, file_name, file_size_bytes,
    mime_type, sha256_hash, version, original_id, is_current_version,
    uploaded_by, upload_source, digitization_date,
    journal_entry_id, journal_entry_line_id, prev_version_hash
  ) VALUES (
    p_user_id, v_current.company_id, p_storage_path, p_file_name,
    p_file_size_bytes, p_mime_type, p_sha256_hash, v_next_version,
    v_root_id, true, p_user_id, v_current.upload_source, now(),
    v_current.journal_entry_id, v_current.journal_entry_line_id,
    v_current.sha256_hash
  )
  RETURNING id INTO v_new_id;

  UPDATE public.document_attachments
  SET is_current_version = false,
      superseded_by_id = v_new_id
  WHERE id = p_original_doc_id;

  -- Audit the legitimate supersession. BFL 7 kap requires the supersession
  -- chain to be reconstructible from immutable storage; the row chain itself
  -- carries the data, but an explicit audit row makes the event visible to
  -- SOC 2 monitoring without joining version timelines.
  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
  VALUES (
    v_caller, v_current.company_id, 'UPDATE', 'document_attachments', p_original_doc_id, v_caller,
    'Document superseded: v' || v_current.version || ' (' || v_current.sha256_hash || ') → v' || v_next_version || ' (' || p_sha256_hash || '); new id=' || v_new_id
  );

  RETURN v_new_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
