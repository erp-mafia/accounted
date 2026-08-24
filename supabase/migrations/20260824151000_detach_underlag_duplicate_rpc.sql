-- detach_underlag_duplicate: the ONE sanctioned path for removing a redundant
-- duplicate underlag from a posted verifikation.
--
-- Problem (support case 2026-08-24): a user uploaded the same underlag twice
-- to one verifikat. Both uploads anchored (document_attachments.journal_entry_id
-- set), which puts them behind the WORM guards: block_document_deletion blocks
-- DELETE and enforce_document_journal_entry_immutability blocks clearing the
-- anchor. The UI could therefore only offer "Ersatt med ny version", a dead
-- end for a plain duplicate.
--
-- Legal analysis: BFL 5 kap 7 par requires the verifikation to reference its
-- underlag, and BFL 7 kap 2 par protects rakenskapsinformation for 7 years.
-- Neither requires TWO copies of the same underlag to stay bound to the
-- verifikat. Detaching one copy is lawful IF AND ONLY IF at least one other
-- anchored underlag remains on the verifikat, and the detached file itself is
-- NOT deleted: it returns to the company's unlinked document pool (storage
-- object and version chain untouched), where the ordinary deleteDocument()
-- rules apply. The operation is recorded in the append-only audit_log before
-- the write, mirroring correct_entry_metadata's log-first ordering.
--
-- Guards, in order:
--   1. caller must be an owner/admin/member of the company (JWT paths verify
--      membership via caller_is_company_member; p_user_id is only honored for
--      service-role callers, which authenticate the user application-side);
--   2. the document must belong to the company, be the current version, and
--      be anchored to a posted journal entry of the same company;
--   3. the entry's fiscal period must be open and unlocked, and the entry
--      date must be after the company lock date (same rattelse window as
--      inline rattelse: past a lock, storno is the only path);
--   4. at least one OTHER current-version document must remain anchored to
--      the same journal entry (the verifikat never loses its last underlag);
--   5. the document must not be pinned as transactions.document_id or
--      supplier_invoices.document_id: those pins have their own immutability
--      rules and consumers, so a pinned doc is replaced, never detached.
--
-- The gnubok.allow_delete carve-out is transaction-local and only set after
-- every guard has passed and the audit row is written, identical in spirit to
-- delete_last_voucher (20260506140000).

CREATE OR REPLACE FUNCTION public.detach_underlag_duplicate(
  p_company_id  uuid,
  p_document_id uuid,
  p_user_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role     text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor        uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role  text;
  v_doc          record;
  v_entry        record;
  v_is_closed    boolean;
  v_locked_at    timestamptz;
  v_lock_date    date;
  v_siblings     integer;
  v_pinned_tx    uuid;
  v_pinned_si    uuid;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan koppla bort underlag.';
  END IF;

  SELECT d.id, d.company_id, d.journal_entry_id, d.file_name, d.is_current_version
    INTO v_doc
    FROM public.document_attachments d
   WHERE d.id = p_document_id
     FOR UPDATE OF d;

  IF NOT FOUND OR v_doc.company_id <> p_company_id THEN
    RAISE EXCEPTION 'Underlaget hittades inte.';
  END IF;
  IF v_doc.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Underlaget är inte kopplat till någon verifikation.';
  END IF;
  IF v_doc.is_current_version IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Endast den aktuella versionen av ett underlag kan kopplas bort.';
  END IF;

  SELECT je.id, je.entry_date, je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = v_doc.journal_entry_id
     FOR UPDATE OF je;

  IF NOT FOUND OR v_entry.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationen hittades inte.';
  END IF;

  SELECT fp.is_closed, fp.locked_at
    INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst: underlaget kan inte kopplas bort.';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_entry.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. %: underlaget kan inte kopplas bort.', v_lock_date;
  END IF;

  -- The verifikat must keep at least one anchored underlag (BFL 5 kap 7 par).
  SELECT count(*) INTO v_siblings
  FROM public.document_attachments d
  WHERE d.journal_entry_id = v_doc.journal_entry_id
    AND d.company_id = p_company_id
    AND d.is_current_version = true
    AND d.id <> v_doc.id;

  IF v_siblings = 0 THEN
    RAISE EXCEPTION 'Verifikationen skulle stå utan underlag: det sista underlaget kan inte kopplas bort. Ersätt det med en ny version i stället.';
  END IF;

  -- A doc pinned to a bank transaction or serving as a supplier invoice's
  -- retained source document is replaced through those flows, never detached.
  SELECT t.id INTO v_pinned_tx
  FROM public.transactions t
  WHERE t.document_id = v_doc.id AND t.company_id = p_company_id
  LIMIT 1;
  IF v_pinned_tx IS NOT NULL THEN
    RAISE EXCEPTION 'Underlaget är kopplat till en banktransaktion och kan inte kopplas bort här. Byt transaktionens underlag i stället.';
  END IF;

  SELECT si.id INTO v_pinned_si
  FROM public.supplier_invoices si
  WHERE si.document_id = v_doc.id AND si.company_id = p_company_id
  LIMIT 1;
  IF v_pinned_si IS NOT NULL THEN
    RAISE EXCEPTION 'Underlaget är leverantörsfakturans originalunderlag och kan inte kopplas bort. Ersätt det med en ny version i stället.';
  END IF;

  -- Append-only audit FIRST: the carve-out below is only ever exercised in a
  -- transaction that has already recorded who detached what from where.
  INSERT INTO public.audit_log
    (user_id, action, table_name, record_id, actor_id, old_state, new_state, description)
  VALUES
    (v_actor, 'UPDATE', 'document_attachments', v_doc.id, v_actor,
     jsonb_build_object('journal_entry_id', v_doc.journal_entry_id, 'company_id', p_company_id, 'file_name', v_doc.file_name),
     jsonb_build_object('journal_entry_id', NULL, 'company_id', p_company_id, 'file_name', v_doc.file_name),
     'Dubblett-underlag frånkopplat från verifikation (annat underlag kvarstår)');

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  UPDATE public.document_attachments
     SET journal_entry_id = NULL,
         journal_entry_line_id = NULL
   WHERE id = v_doc.id;

  PERFORM set_config('gnubok.allow_delete', 'false', true);

  RETURN jsonb_build_object(
    'detached', true,
    'document_id', v_doc.id,
    'journal_entry_id', v_doc.journal_entry_id,
    'remaining_documents', v_siblings
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.detach_underlag_duplicate(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.detach_underlag_duplicate(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
