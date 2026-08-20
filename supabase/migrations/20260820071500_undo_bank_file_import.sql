-- Undo a bank file import (issue #1672).
--
-- A bad bank-file import (e.g. a mis-parsed CSV) could not be cleaned up:
-- re-importing dedup-skips the bad rows, the single-row DELETE refuses
-- imported rows by design (TRANSACTION_DELETE_IMPORTED), and there was no
-- bulk action. Transactions also did not record WHICH import batch inserted
-- them, so a strictly scoped "undo this import" was impossible.
--
-- Two pieces:
--
-- 1. transactions.bank_file_import_id: the batch link, stamped at ingest by
--    the bank-file import paths (dashboard execute route + v1 REST route).
--    NULL for rows predating this migration and for every other source (PSD2
--    sync, manual, MCP). Pre-existing imports therefore cannot be undone
--    through this action: there is no reliable retroactive attribution, and a
--    fuzzy backfill (format + date window) could delete rows belonging to a
--    DIFFERENT import, which is exactly the footgun this feature must not be.
--
-- 2. undo_bank_file_import RPC: owner/admin-only bulk delete of the batch's
--    unbooked transactions, ignored rows INCLUDED (is_ignored is deliberately
--    not filtered on). Never touched, and reported back instead:
--      * booked rows: journal_entry_id set, an invoice/supplier-invoice link,
--        an invoice_payments / supplier_invoice_payments row, or a
--        transaction_voucher_links row (the is_transaction_booked() predicate,
--        20260529120000). Those rows are räkenskapsinformation; the fix for a
--        wrong booking is unlink or storno, never delete.
--      * rows with payment_match_log history: the log is append-only
--        räkenskapsinformation (BFL 7 kap, 20260323120000) and its FK cascades
--        on transaction delete, which the audit_log_immutable trigger blocks.
--        Same rule as the single-row DELETE route
--        (TRANSACTION_DELETE_HAS_AUDIT_TRAIL); such rows can be ignored, not
--        deleted.
--    The actor gate mirrors the hardened undo_sie_import shape
--    (20260727121000): p_user_id is honored only for service_role callers
--    (the cookieless server client, auth.uid() NULL); every other caller is
--    pinned to its own auth.uid(). Raises 42501 otherwise.

ALTER TABLE public.transactions
  ADD COLUMN bank_file_import_id uuid
    REFERENCES public.bank_file_imports(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.transactions.bank_file_import_id IS
  'The bank_file_imports batch that inserted this row (bank-file CSV/CAMT import paths only). NULL for PSD2/manual/MCP rows and rows imported before 20260819100000. Scope key for undo_bank_file_import.';

-- Only a small fraction of transactions carry the link; the undo path and the
-- import detail views filter on it directly.
CREATE INDEX idx_transactions_bank_file_import_id
  ON public.transactions (bank_file_import_id)
  WHERE bank_file_import_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.undo_bank_file_import(
  p_company_id uuid,
  p_import_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 -- The authenticated role carries statement_timeout=8s on hosted Supabase; a
 -- multi-thousand-row batch delete must not race that budget. Same shape as
 -- undo_sie_import (20260629160100 / 20260727121000).
 SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_actor                   uuid;
  v_caller_role             text;
  v_status                  text;
  v_filename                text;
  v_deleted                 integer := 0;
  v_skipped_booked          integer := 0;
  v_skipped_match_history   integer := 0;
BEGIN
  -- Actor resolution: p_user_id is an assertion by the caller, honored ONLY
  -- for the service role (cookieless server client, auth.uid() NULL). Any
  -- other caller is pinned to its own auth.uid(). Same guard as
  -- undo_sie_import (20260727121000).
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can undo bank file imports'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the import row: serializes concurrent undo calls and any concurrent
  -- re-import upsert of the same (company_id, file_hash) row.
  SELECT status, filename
    INTO v_status, v_filename
    FROM public.bank_file_imports
   WHERE id = p_import_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found', p_import_id;
  END IF;

  IF v_status <> 'completed' THEN
    RAISE EXCEPTION 'Import % is not in completed status (status: %)', p_import_id, v_status;
  END IF;

  -- Booked rows the undo will NOT touch: any anchor to a verifikat (direct
  -- journal_entry_id, denormalized invoice links, payment rows, or a
  -- voucher-link junction row). Counted for the report.
  SELECT count(*) INTO v_skipped_booked
  FROM public.transactions t
  WHERE t.company_id = p_company_id
    AND t.bank_file_import_id = p_import_id
    AND (
      t.journal_entry_id IS NOT NULL
      OR t.invoice_id IS NOT NULL
      OR t.supplier_invoice_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.transaction_id = t.id)
      OR EXISTS (SELECT 1 FROM public.supplier_invoice_payments sip WHERE sip.transaction_id = t.id)
      OR EXISTS (SELECT 1 FROM public.transaction_voucher_links tvl WHERE tvl.transaction_id = t.id)
    );

  -- Unbooked rows with payment_match_log history: their log rows are
  -- append-only räkenskapsinformation whose FK cascades on delete, which the
  -- audit_log_immutable trigger rejects. Skipped and reported.
  SELECT count(*) INTO v_skipped_match_history
  FROM public.transactions t
  WHERE t.company_id = p_company_id
    AND t.bank_file_import_id = p_import_id
    AND t.journal_entry_id IS NULL
    AND t.invoice_id IS NULL
    AND t.supplier_invoice_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.transaction_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_payments sip WHERE sip.transaction_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links tvl WHERE tvl.transaction_id = t.id)
    AND EXISTS (SELECT 1 FROM public.payment_match_log pml WHERE pml.transaction_id = t.id);

  -- Delete the batch's unbooked, history-free rows. is_ignored is deliberately
  -- NOT filtered: an ignored row is still unbooked staging data and undoing
  -- the import must clear it too (the reporting user's exact complaint).
  WITH deleted AS (
    DELETE FROM public.transactions t
     WHERE t.company_id = p_company_id
       AND t.bank_file_import_id = p_import_id
       AND t.journal_entry_id IS NULL
       AND t.invoice_id IS NULL
       AND t.supplier_invoice_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_payments sip WHERE sip.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links tvl WHERE tvl.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.payment_match_log pml WHERE pml.transaction_id = t.id)
    RETURNING id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  UPDATE public.bank_file_imports
     SET status = 'undone'
   WHERE id = p_import_id
     AND company_id = p_company_id;

  -- Behandlingshistorik: one summary row for the bulk delete. Transactions
  -- carry no per-row audit trigger, so without this the undo would leave no
  -- trace of what was removed and by whom.
  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description
  ) VALUES (
    v_actor, p_company_id, 'DELETE', 'transactions', p_import_id, v_actor,
    jsonb_build_object('bank_file_import_id', p_import_id, 'filename', v_filename),
    jsonb_build_object(
      'deleted_transactions', v_deleted,
      'skipped_booked', v_skipped_booked,
      'skipped_match_history', v_skipped_match_history
    ),
    'Bank file import undone: batch''s unbooked transactions (ignored included) hard-deleted'
  );

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'skipped_booked', v_skipped_booked,
    'skipped_match_history', v_skipped_match_history
  );
END;
$function$;

-- Least privilege, same discipline as undo_sie_import (20260727121000):
-- CREATE FUNCTION applies the Supabase default grants (PUBLIC + anon +
-- authenticated + service_role), so PUBLIC and anon are revoked explicitly
-- and the two legitimate callers re-asserted: service_role for the normal
-- server path, authenticated for the session-client fallback (scoped by the
-- in-function owner/admin gate).
REVOKE EXECUTE ON FUNCTION public.undo_bank_file_import(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_bank_file_import(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.undo_bank_file_import(uuid, uuid, uuid) IS
  'Hard-deletes a completed bank-file import batch''s unbooked transactions (ignored included), scoped by transactions.bank_file_import_id. Booked rows and rows with payment_match_log history are skipped and reported. Requires the actor to be an owner or admin of p_company_id; p_user_id is honored only for service_role callers, every other caller resolves from its own auth.uid(). Raises 42501 otherwise. Not callable by anon.';

NOTIFY pgrst, 'reload schema';
