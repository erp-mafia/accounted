-- Fix service-role detection in relink_documents_to_correction().
--
-- The original (20260704103000) keyed the service-role branch on auth.role().
-- In the supabase/postgres image auth.role() reads the SINGULAR
-- request.jwt.claim.role GUC, which PostgREST v10+ (and the pg-real harness)
-- no longer populate: only the request.jwt.claims JSON object carries the
-- role. So a genuine service-role caller (pending-operations executor / MCP
-- approve flow) whose claims are {"role":"service_role"} with no sub landed in
-- the ELSE branch and got "Authentication required to relink documents",
-- stranding underlag on the reversed original exactly as before the fix.
--
-- Align with the canonical tenant-guard convention
-- (20260615120000_link_voucher_rpcs_tenant_guard.sql): read the role straight
-- from the request.jwt.claims JSON. anon/authenticated sessions stay keyed on
-- auth.uid() (p_user_id must match the JWT subject, no spoofing); service_role
-- and direct/no-claims callers (MCP / API-key / migrations / pg-harness) trust
-- p_user_id, which is still membership-checked below.
--
-- Also fixes a durability regression in 20260704103000: that migration guarded
-- journal_entry_id at the entry-level trigger but delegated journal_entry_line_id
-- to the metadata trigger, which exempts draft-linked documents. That let a set
-- journal_entry_line_id be cleared to NULL on a draft-linked doc, breaking the
-- "link durable from first set" invariant (document-immutability.pg). Restore
-- line-id durability in the entry-level trigger (status-independent), exempting
-- only the correction-relink path, which legitimately clears line_id when it
-- moves the underlag from the reversed original to its posted correction.

-- Entry-level link trigger: journal_entry_id AND journal_entry_line_id are both
-- durable once set. uuid -> uuid moves and the line-id clear happen only under
-- the correction-relink GUC.
CREATE OR REPLACE FUNCTION public.enforce_document_journal_entry_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- Correction relink: set ONLY by relink_documents_to_correction() after it
  -- has validated the correction chain. It moves journal_entry_id uuid -> uuid
  -- and clears journal_entry_line_id to NULL. Both are allowed only here, and
  -- only as long as journal_entry_id is not itself cleared (a NULL there would
  -- be a soft-delete bypass of BFL 7 kap 2 §).
  IF current_setting('gnubok.allow_correction_relink', true) = 'true'
     AND NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- journal_entry_id: once set, cannot be cleared or re-pointed.
  IF OLD.journal_entry_id IS NOT NULL
     AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_id on document % once set (BFL 5 kap 6 §). Reverse the journal entry first.',
      OLD.id;
  END IF;

  -- journal_entry_line_id: same durability. Setting it from NULL -> uuid (a
  -- later, more precise link) stays allowed; clearing or re-pointing a set
  -- value is blocked, status-independent.
  IF OLD.journal_entry_line_id IS NOT NULL
     AND NEW.journal_entry_line_id IS DISTINCT FROM OLD.journal_entry_line_id THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_line_id on document % once set (BFL 5 kap 6 §).',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

-- The trigger fired only on `UPDATE OF journal_entry_id`, so a line-id-only
-- UPDATE (SET journal_entry_line_id = NULL) never invoked the function at all,
-- which is why the durability guard above needs a wider column list to bite.
DROP TRIGGER IF EXISTS enforce_document_journal_entry_immutability
  ON public.document_attachments;
CREATE TRIGGER enforce_document_journal_entry_immutability
  BEFORE UPDATE OF journal_entry_id, journal_entry_line_id
  ON public.document_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_document_journal_entry_immutability();

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
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_from journal_entries%ROWTYPE;
  v_to journal_entries%ROWTYPE;
  v_is_member boolean;
  v_moved integer;
BEGIN
  -- Caller identity. Two legitimate caller shapes:
  --   - authenticated user session (role anon/authenticated): auth.uid() is
  --     present and MUST match p_user_id (the route layer passes the user's
  --     own id; a mismatch is always malicious).
  --   - service-role / direct (pending-operations executor / MCP approve flow
  --     / migrations / pg-harness): no user JWT subject; p_user_id is trusted
  --     and still membership-checked below. See undo_sie_import's auth.uid()
  --     regression for why service-role callers must not be keyed on
  --     auth.uid().
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'Authentication required to relink documents';
    END IF;
    IF p_user_id IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'p_user_id does not match authenticated user';
    END IF;
  ELSE
    IF p_user_id IS NULL THEN
      RAISE EXCEPTION 'p_user_id is required';
    END IF;
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
