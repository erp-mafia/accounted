-- create_document_version carries the link basis of the version it replaces
-- (link basis, src/lib/links/link-basis.ts).
-- pg-test: tests/pg/link-basis-sql-writers.pg.test.ts
--
-- A new version of an underlag takes over the verifikat link of the current
-- version (journal_entry_id, journal_entry_line_id are copied), so it is the
-- same link, moved, not a new one. Its link_basis and link_evidence are
-- copied with it, as storno-service.ts keeps the basis when it moves a bank
-- row's link to the correction. NULL stays NULL. No resolution happens here,
-- so public.resolve_link_basis is not called: nobody paired anything anew.
--
-- What does not change: the signature, SECURITY DEFINER, search_path, owner,
-- grants and comment (CREATE OR REPLACE keeps them), the role gate, the
-- storage path rule, the supersede flip and the audit row. The body below is
-- the newest definition,
-- 20260902093000_security_role_gates_membership_and_posting_integrity,
-- copied byte for byte; the only edit is the two columns added to the
-- document_attachments insert.

CREATE OR REPLACE FUNCTION public.create_document_version(
  p_user_id uuid, p_original_doc_id uuid, p_storage_path text, p_file_name text,
  p_file_size_bytes bigint, p_mime_type text, p_sha256_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_current document_attachments%ROWTYPE;
  v_new_id uuid;
  v_root_id uuid;
  v_next_version integer;
  v_caller_role text;
BEGIN
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

  SELECT cm.role INTO v_caller_role
  FROM public.company_members cm
  WHERE cm.company_id = v_current.company_id
    AND cm.user_id = v_caller;

  IF v_caller_role IS NULL THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (v_caller, v_current.company_id, 'SECURITY_EVENT', 'document_attachments', p_original_doc_id,
      'Blocked cross-company create_document_version attempt');
    RAISE EXCEPTION 'User is not a member of the document''s company';
  END IF;

  -- Read-only members supersede nothing: same rule as every document write.
  IF v_caller_role = 'viewer' THEN
    RAISE EXCEPTION 'read-only role cannot create document versions' USING ERRCODE = '42501';
  END IF;

  -- The new object must live in this company's folder (or the caller's own
  -- legacy user folder): a foreign key would re-anchor another tenant's file.
  IF p_storage_path IS NULL
     OR NOT (
       p_storage_path LIKE 'documents/' || v_current.company_id::text || '/%'
       OR p_storage_path LIKE 'documents/' || v_caller::text || '/%'
     ) THEN
    RAISE EXCEPTION 'storage_path must be under the document''s company folder' USING ERRCODE = '42501';
  END IF;

  v_root_id := COALESCE(v_current.original_id, v_current.id);
  v_next_version := v_current.version + 1;

  PERFORM set_config('gnubok.allow_supersede', 'true', true);

  INSERT INTO public.document_attachments (
    user_id, company_id, storage_path, file_name, file_size_bytes,
    mime_type, sha256_hash, version, original_id, is_current_version,
    uploaded_by, upload_source, digitization_date,
    journal_entry_id, journal_entry_line_id, prev_version_hash,
    link_basis, link_evidence
  ) VALUES (
    p_user_id, v_current.company_id, p_storage_path, p_file_name,
    p_file_size_bytes, p_mime_type, p_sha256_hash, v_next_version,
    v_root_id, true, p_user_id, v_current.upload_source, now(),
    v_current.journal_entry_id, v_current.journal_entry_line_id,
    v_current.sha256_hash,
    v_current.link_basis, v_current.link_evidence
  )
  RETURNING id INTO v_new_id;

  UPDATE public.document_attachments
  SET is_current_version = false,
      superseded_by_id = v_new_id
  WHERE id = p_original_doc_id;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
  VALUES (
    v_caller, v_current.company_id, 'UPDATE', 'document_attachments', p_original_doc_id, v_caller,
    'Document superseded: v' || v_current.version || ' (' || v_current.sha256_hash || ') -> v' || v_next_version || ' (' || p_sha256_hash || '); new id=' || v_new_id
  );

  RETURN v_new_id;
END;
$$;
