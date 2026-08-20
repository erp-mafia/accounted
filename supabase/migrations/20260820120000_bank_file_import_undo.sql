-- Bank-file import undo (issue #1672).
--
-- After a bad CSV/CAMT import the customer could not recover: re-imports of
-- the corrected file silently dedup against the bad rows, the single-row
-- delete route hard-refuses imported rows by design, and there was no bulk
-- delete. Two changes, mirroring the SIE undo path
-- (20260702154500_dimension_import_provenance_undo_lockstep.sql):
--
--   1. `bank_file_import_id` provenance on transactions (NULL for rows that
--      predate this migration or came from other channels; ON DELETE SET NULL
--      so deleting an old bank_file_imports row never cascades into
--      transactions). Populated by ingestTransactions when the bank-file
--      execute route runs. No backfill: pre-existing imports carry no
--      reliable batch identity, so undo applies to new imports only.
--   2. `undo_bank_file_import` RPC: owner/admin-gated bulk delete of the
--      batch's UNBOOKED rows, ignored rows included. Rows anchored to any
--      verifikat (is_transaction_booked: journal_entry_id, invoice_payments,
--      supplier_invoice_payments, transaction_voucher_links) are NEVER
--      deleted; rows with payment_match_log history are skipped too (the
--      log is append-only rakenskapsinformation per BFL 7:1 and its
--      ON DELETE CASCADE is blocked by audit_log_immutable). Both skip
--      buckets are counted and returned so the UI can report exactly what
--      was left in place. Journal entries are never touched, so period
--      locks and voucher sequences are out of scope by construction.
--
-- pg-test: tests/pg/undo-bank-file-import.pg.test.ts

ALTER TABLE public.transactions
  ADD COLUMN bank_file_import_id uuid
    REFERENCES public.bank_file_imports(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.transactions.bank_file_import_id IS
  'Bank-file import batch (bank_file_imports) that inserted this row. NULL for rows from other channels or imports predating 2026-08. Enables undo_bank_file_import.';

-- Undo looks rows up by import id; the partial index keeps the common case
-- (non-file rows, NULL) out of the index entirely.
CREATE INDEX idx_transactions_bank_file_import
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
AS $function$
DECLARE
  v_caller_role     text;
  v_actor           uuid := COALESCE(p_user_id, auth.uid());
  v_import_status   text;
  v_imported_count  integer;
  v_total           integer := 0;
  v_skipped_booked  integer := 0;
  v_skipped_matched integer := 0;
  v_deleted         integer := 0;
  v_deleted_ignored integer := 0;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can undo bank file imports';
  END IF;

  SELECT bfi.status, bfi.imported_count
    INTO v_import_status, v_imported_count
    FROM public.bank_file_imports bfi
   WHERE bfi.id = p_import_id
     AND bfi.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found', p_import_id;
  END IF;

  -- 'completed' is the normal case; 'failed' covers a partially-inserted run
  -- (status failed only when imported=0, but stay permissive: linked rows are
  -- what actually drives the delete). 'undone' is the idempotency stop.
  IF v_import_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Import % is not in an undoable status (status: %)', p_import_id, v_import_status;
  END IF;

  -- Classify the batch. Booked rows (any anchor path) are legally out of
  -- reach; rows with payment_match_log history cannot be deleted (the log is
  -- append-only and blocks the FK cascade), so they are skipped and reported
  -- rather than failing the whole undo.
  SELECT
    count(*),
    count(*) FILTER (WHERE public.is_transaction_booked(t.id)),
    count(*) FILTER (
      WHERE NOT public.is_transaction_booked(t.id)
        AND EXISTS (
          SELECT 1 FROM public.payment_match_log pml
          WHERE pml.transaction_id = t.id
        )
    )
    INTO v_total, v_skipped_booked, v_skipped_matched
    FROM public.transactions t
   WHERE t.company_id = p_company_id
     AND t.bank_file_import_id = p_import_id;

  -- A completed import with imported rows but no linked transactions predates
  -- the provenance column: undo cannot know which rows belong to the batch,
  -- so refuse instead of "succeeding" while deleting nothing.
  IF v_total = 0 AND COALESCE(v_imported_count, 0) > 0 THEN
    RAISE EXCEPTION 'Import % has no linked transactions (imported before batch linking); undo is not available for it', p_import_id;
  END IF;

  -- Delete the deletable slice: unbooked (by every anchor path) and without
  -- match history. Ignored rows are included by design; the
  -- transactions_is_ignored_no_journal_entry constraint guarantees an ignored
  -- row has no journal entry (#1683). Conditions are re-evaluated inside the
  -- DELETE itself, so a row booked between the count above and this statement
  -- is skipped, not deleted.
  WITH deleted AS (
    DELETE FROM public.transactions t
     WHERE t.company_id = p_company_id
       AND t.bank_file_import_id = p_import_id
       AND NOT public.is_transaction_booked(t.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.payment_match_log pml
         WHERE pml.transaction_id = t.id
       )
    RETURNING t.is_ignored
  )
  SELECT count(*), count(*) FILTER (WHERE is_ignored)
    INTO v_deleted, v_deleted_ignored
    FROM deleted;

  UPDATE public.bank_file_imports
     SET status = 'undone'
   WHERE id = p_import_id
     AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'deleted_ignored', v_deleted_ignored,
    'skipped_booked', v_skipped_booked,
    'skipped_matched', v_skipped_matched
  );
END;
$function$;

COMMENT ON FUNCTION public.undo_bank_file_import(uuid, uuid, uuid) IS
  'Undo a bank-file import: deletes the batch''s unbooked transactions (ignored included), skips and reports booked rows and rows with payment_match_log history, marks the import undone. Owner/admin only.';

REVOKE ALL ON FUNCTION public.undo_bank_file_import(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_bank_file_import(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
