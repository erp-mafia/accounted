-- Make correctEntry()'s document relink legal — via a validated RPC.
--
-- Background: relinkDocumentsToEntry (storno-service, added 2026-06-01) moves
-- underlag from a corrected (now 'reversed') entry to its correction so the
-- live verifikat carries its documents. But the immutability triggers that
-- landed 2026-05-06 forbid ANY change to a set journal_entry_id:
--   - enforce_document_journal_entry_immutability blocks unconditionally
--     (its "Reverse the journal entry first" message notwithstanding — it
--     never inspects entry status), and
--   - enforce_document_metadata_immutability additionally blocks when the
--     linked entry is posted OR reversed.
-- The relink therefore failed 100% of the time, its error was swallowed, and
-- every correction of an entry with attached underlag silently stranded the
-- documents on the reversed original.
--
-- Fix, following the gnubok.allow_supersede precedent (20260527130000): a
-- transaction-local GUC (gnubok.allow_correction_relink) that ONLY the
-- SECURITY DEFINER RPC relink_documents_to_correction() sets, after
-- validating that the move follows a genuine correction chain:
--   from-entry status 'reversed', to-entry status 'posted',
--   to.correction_of_id = from.id, same company, caller authorized.
-- The GUC bypass in the triggers is deliberately narrow: journal_entry_id
-- may only move uuid → uuid (never to NULL — that path would be a
-- soft-delete bypass of BFL 7 kap 2§), and every other guarded field stays
-- immutable even with the GUC set.

-- ── 1. Entry-link trigger: allow uuid → uuid under the relink GUC ─────────
CREATE OR REPLACE FUNCTION public.enforce_document_journal_entry_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;

  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Correction relink: set ONLY by relink_documents_to_correction() after it
  -- has validated the correction chain. uuid → uuid moves only; clearing to
  -- NULL stays blocked even with the GUC (that would be a delete bypass).
  IF current_setting('gnubok.allow_correction_relink', true) = 'true'
     AND NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.journal_entry_id IS NULL OR NEW.journal_entry_id <> OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_id on document % once set (BFL 5 kap 6 §). Reverse the journal entry first.',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. Metadata trigger: exempt the two link columns under the same GUC ───
CREATE OR REPLACE FUNCTION public.enforce_document_metadata_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_status text;
  v_allow_supersede boolean;
  v_allow_relink boolean;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  v_allow_supersede := current_setting('gnubok.allow_supersede', true) = 'true';
  v_allow_relink := current_setting('gnubok.allow_correction_relink', true) = 'true';

  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_entry_status
  FROM public.journal_entries
  WHERE id = OLD.journal_entry_id;

  IF v_entry_status IS NULL OR v_entry_status NOT IN ('posted', 'reversed') THEN
    RETURN NEW;
  END IF;

  -- Even with allow_supersede or allow_correction_relink, every field other
  -- than the ones each narrow bypass covers remains immutable. A session
  -- that obtains a GUC (e.g. via SQL injection) still cannot mutate
  -- sha256_hash, storage_path, or any other field the BFL 7 kap audit trail
  -- depends on.
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
     OR (NOT v_allow_relink
         AND (NEW.journal_entry_id      IS DISTINCT FROM OLD.journal_entry_id
              OR NEW.journal_entry_line_id IS DISTINCT FROM OLD.journal_entry_line_id))
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

-- ── 3. The validated relink RPC ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.relink_documents_to_correction(
  p_user_id uuid,
  p_from_entry_id uuid,
  p_to_entry_id uuid
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_role text := auth.role();
  v_from journal_entries%ROWTYPE;
  v_to journal_entries%ROWTYPE;
  v_is_member boolean;
  v_moved integer;
BEGIN
  -- Caller identity. Two legitimate caller shapes:
  --   - authenticated user session: auth.uid() present and MUST match
  --     p_user_id (the route layer passes the user's own id; a mismatch is
  --     always malicious).
  --   - service-role (pending-operations executor / MCP approve flow):
  --     auth.uid() is NULL, auth.role() = 'service_role'; p_user_id is
  --     trusted and still membership-checked below. See
  --     undo_sie_import's auth.uid() regression for why service-role
  --     callers must not be keyed on auth.uid().
  IF v_role = 'service_role' THEN
    IF p_user_id IS NULL THEN
      RAISE EXCEPTION 'p_user_id is required';
    END IF;
  ELSIF v_caller IS NOT NULL THEN
    IF p_user_id IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'p_user_id does not match authenticated user';
    END IF;
  ELSE
    RAISE EXCEPTION 'Authentication required to relink documents';
  END IF;

  SELECT * INTO v_from FROM public.journal_entries WHERE id = p_from_entry_id;
  IF v_from.id IS NULL THEN
    RAISE EXCEPTION 'Source entry % not found', p_from_entry_id;
  END IF;

  SELECT * INTO v_to FROM public.journal_entries WHERE id = p_to_entry_id;
  IF v_to.id IS NULL THEN
    RAISE EXCEPTION 'Target entry % not found', p_to_entry_id;
  END IF;

  -- Tenant boundary: both entries in one company, and the acting user must
  -- be a member. SECURITY DEFINER bypasses RLS, so enforce it here.
  IF v_from.company_id IS DISTINCT FROM v_to.company_id THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (p_user_id, v_from.company_id, 'SECURITY_EVENT', 'document_attachments', p_from_entry_id,
      'Blocked cross-company document relink attempt to entry ' || p_to_entry_id);
    RAISE EXCEPTION 'Entries belong to different companies';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = v_from.company_id AND cm.user_id = p_user_id
  ) INTO v_is_member;
  IF NOT v_is_member THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (p_user_id, v_from.company_id, 'SECURITY_EVENT', 'document_attachments', p_from_entry_id,
      'Blocked document relink by non-member');
    RAISE EXCEPTION 'User is not a member of the entries'' company';
  END IF;

  -- The move is only legal along a genuine correction chain: the target is
  -- the posted correction of the reversed source. Anything else is an
  -- arbitrary re-link, which BFL 5 kap 6 § forbids.
  IF v_from.status <> 'reversed' THEN
    RAISE EXCEPTION 'Source entry % is not reversed (status: %)', p_from_entry_id, v_from.status;
  END IF;
  IF v_to.status <> 'posted' THEN
    RAISE EXCEPTION 'Target entry % is not posted (status: %)', p_to_entry_id, v_to.status;
  END IF;
  IF v_to.correction_of_id IS DISTINCT FROM p_from_entry_id THEN
    RAISE EXCEPTION 'Target entry % is not the correction of source entry %', p_to_entry_id, p_from_entry_id;
  END IF;

  -- Transaction-local: resets automatically at COMMIT/ROLLBACK.
  PERFORM set_config('gnubok.allow_correction_relink', 'true', true);

  UPDATE public.document_attachments
  SET journal_entry_id = p_to_entry_id,
      journal_entry_line_id = NULL
  WHERE company_id = v_from.company_id
    AND journal_entry_id = p_from_entry_id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  IF v_moved > 0 THEN
    -- The row chain (correction_of_id) carries the legal traceability; this
    -- audit row makes the underlag move visible without joining timelines.
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
    VALUES (p_user_id, v_from.company_id, 'UPDATE', 'document_attachments', p_from_entry_id, p_user_id,
      'Relinked ' || v_moved || ' document(s) from reversed entry ' || p_from_entry_id || ' to correction ' || p_to_entry_id);
  END IF;

  RETURN v_moved;
END;
$function$;

NOTIFY pgrst, 'reload schema';
