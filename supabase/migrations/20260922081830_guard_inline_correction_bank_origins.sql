-- A posted bank origin exists before its later link request. Inline correction
-- must retain the bank net in that gap, especially for partial payments whose
-- voucher does not consume the source transaction's full amount. Once linked,
-- the existing allocated-amount reconciliation rule remains authoritative.
DO $migration$
DECLARE
  v_definition text := replace(pg_get_functiondef('public.correct_entry_lines_inline(uuid,uuid,uuid[],jsonb,uuid)'::regprocedure), E'\r\n', E'\n');
  v_old text;
BEGIN
  IF position('PERFORM public.lock_cash_account_company(p_company_id)' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Inline correction company coordination prerequisite missing';
  END IF;
  v_old := '  v_bank_linked     boolean;';
  IF (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Unexpected inline correction declaration';
  END IF;
  v_definition := replace(v_definition,v_old,v_old || E'\n  v_bank_origin_unlinked boolean;');
  v_old := '  v_bank_linked := EXISTS (SELECT 1 FROM public.transactions t WHERE t.journal_entry_id = p_entry_id)';
  IF (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Unexpected inline correction anchor definition';
  END IF;
  v_definition := replace(v_definition,v_old,$replacement$
  -- Source context is immutable after posting and also covers invoice and
  -- supplier payment vouchers. Missing/partial links must not turn a bank
  -- origin into an unrestricted manual voucher during correction.
  v_bank_origin_unlinked := EXISTS (
    SELECT 1 FROM (
      SELECT j.source_id AS transaction_id FROM public.journal_entries j
        WHERE j.company_id = p_company_id AND j.id = p_entry_id AND j.source_type = 'bank_transaction'
      UNION
      SELECT (c->>'transaction_id')::uuid FROM public.journal_entries j,
        LATERAL jsonb_array_elements(j.bank_booking_context) c
        WHERE j.company_id = p_company_id AND j.id = p_entry_id
    ) origin WHERE NOT EXISTS (
      SELECT 1 FROM public.transactions t WHERE t.company_id = p_company_id AND t.id = origin.transaction_id
        AND (t.journal_entry_id = p_entry_id OR EXISTS (
          SELECT 1 FROM public.transaction_voucher_links l WHERE l.transaction_id = t.id
            AND l.journal_entry_id = p_entry_id AND l.role = 'bank_line'))
    )
  );
  v_bank_linked := v_bank_origin_unlinked
                OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.journal_entry_id = p_entry_id)$replacement$);
  v_old := $old$           SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.company_id = p_company_id)) THEN
        -- Signed bank amount anchored on this account across every linked$old$;
  IF (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Unexpected inline correction bank net guard';
  END IF;
  v_definition := replace(v_definition,v_old,$replacement$           SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.company_id = p_company_id)) THEN
        IF v_bank_origin_unlinked THEN
          RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
        END IF;
        -- Signed bank amount anchored on this account across every linked$replacement$);
  EXECUTE v_definition;
END;
$migration$;
NOTIFY pgrst, 'reload schema';
