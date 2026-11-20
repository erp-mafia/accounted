-- Serialize atomic booking RPCs with account promotion before taking business
-- row locks. Keep their existing authorization, settlement, numbering and
-- rollback behavior. No accounting enforcement trigger is changed.
CREATE FUNCTION public.lock_cash_account_booking_state(p_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  PERFORM public.lock_cash_account_company(p_company_id);
  PERFORM 1 FROM public.bank_connections
    WHERE company_id = p_company_id ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.cash_accounts
    WHERE company_id = p_company_id ORDER BY id FOR SHARE;
END;
$function$;

-- SQL booking entry points build their source snapshot inside their atomic
-- operation. The current binding is authoritative; user-provided lines must
-- still pass the pre-posting guard. Unbound legacy rows follow the existing
-- resolveSettlementAccount fallback: sole enabled currency account, else 1930.
CREATE FUNCTION public.capture_bank_booking_context(p_company_id uuid, p_transaction_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_transaction public.transactions%ROWTYPE;
  v_ledger text;
  v_count integer;
  v_seen integer := 0;
  v_context jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.lock_cash_account_booking_state(p_company_id);
  IF p_transaction_ids IS NULL OR cardinality(p_transaction_ids) = 0
     OR array_position(p_transaction_ids, NULL) IS NOT NULL
     OR cardinality(p_transaction_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_transaction_ids) ids(id)) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_transaction IN
    SELECT * FROM public.transactions
    WHERE company_id = p_company_id AND id = ANY(p_transaction_ids)
    ORDER BY id FOR UPDATE
  LOOP
    v_seen := v_seen + 1;
    IF v_transaction.cash_account_id IS NOT NULL THEN
      SELECT ledger_account INTO v_ledger FROM public.cash_accounts
        WHERE company_id = p_company_id AND id = v_transaction.cash_account_id
          AND currency = v_transaction.currency;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'BANK_BOOKING_CASH_ACCOUNT_MISSING' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT count(*), min(ledger_account) INTO v_count, v_ledger
        FROM public.cash_accounts
        WHERE company_id = p_company_id AND enabled AND currency = v_transaction.currency;
      IF v_count <> 1 THEN v_ledger := '1930'; END IF;
    END IF;
    v_context := v_context || jsonb_build_array(jsonb_build_object(
      'transaction_id', v_transaction.id, 'cash_account_id', v_transaction.cash_account_id,
      'date', to_char(v_transaction.date, 'YYYY-MM-DD'), 'amount', v_transaction.amount,
      'currency', v_transaction.currency, 'settlement_account', v_ledger
    ));
  END LOOP;
  IF v_seen <> cardinality(p_transaction_ids) THEN
    RAISE EXCEPTION 'BANK_BOOKING_SOURCE_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  RETURN v_context;
END;
$function$;
REVOKE ALL ON FUNCTION public.lock_cash_account_booking_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.capture_bank_booking_context(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_cash_account_booking_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.capture_bank_booking_context(uuid, uuid[]) TO authenticated, service_role;

-- Narrow, checked edits preserve each installed routine's unrelated behavior
-- and grants. Refuse unexpected definitions instead of silently missing a
-- writer. Historical definitions use both CRLF and LF line endings.
DO $migration$
DECLARE
  v_patch jsonb;
  v_definition text;
  v_old text;
  v_count integer;
BEGIN
  FOR v_patch IN SELECT value FROM jsonb_array_elements($patches$
[
  {
    "signature": "public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)",
    "old_text": "  FOR v_tx IN\n    SELECT * FROM public.transactions",
    "new_text": "  PERFORM public.lock_cash_account_booking_state(p_company_id);\n\n  FOR v_tx IN\n    SELECT * FROM public.transactions",
    "expected": 1
  },
  {
    "signature": "public.match_batch_allocate(uuid,jsonb,uuid,uuid)",
    "old_text": "  SELECT * INTO v_tx FROM public.transactions",
    "new_text": "  PERFORM public.lock_cash_account_booking_state(p_company_id);\n\n  SELECT * INTO v_tx FROM public.transactions",
    "expected": 1
  },
  {
    "signature": "public.create_expense_payout_batch(uuid,uuid[],date,text,text,uuid,uuid)",
    "old_text": "  -- Lock the claims.",
    "new_text": "  PERFORM public.lock_cash_account_booking_state(p_company_id);\n\n  -- Lock the claims.",
    "expected": 1
  },
  {
    "signature": "public.link_invoice_to_voucher(uuid,uuid,uuid,uuid,text)",
    "old_text": "  SELECT * INTO v_invoice\n",
    "new_text": "  PERFORM public.lock_cash_account_company(p_company_id);\n\n  SELECT * INTO v_invoice\n",
    "expected": 1
  },
  {
    "signature": "public.link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text)",
    "old_text": "  SELECT * INTO v_invoice\n",
    "new_text": "  PERFORM public.lock_cash_account_company(p_company_id);\n\n  SELECT * INTO v_invoice\n",
    "expected": 1
  },
  {
    "signature": "public.commit_asset_disposal(uuid,uuid,uuid,uuid,text,date,numeric,numeric,text,numeric,numeric,text,integer,integer,numeric,numeric,numeric,text,text)",
    "old_text": "  SELECT a.user_id\n",
    "new_text": "  PERFORM public.lock_cash_account_company(p_company_id);\n\n  SELECT a.user_id\n",
    "expected": 1
  },
  {
    "signature": "public.commit_opening_balance_replacement(uuid,uuid,uuid,uuid,date,text,text,jsonb,text,text)",
    "old_text": "  SELECT fp.*\n",
    "new_text": "  PERFORM public.lock_cash_account_company(p_company_id);\n\n  SELECT fp.*\n",
    "expected": 1
  },
  {
    "signature": "public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)",
    "old_text": "  v_tx RECORD;",
    "new_text": "  v_tx RECORD;\n  v_bank_context jsonb;",
    "expected": 1
  },
  {
    "signature": "public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)",
    "old_text": "  v_total_amount_abs := ABS(v_total_amount);",
    "new_text": "  v_total_amount_abs := ABS(v_total_amount);\n  v_bank_context := public.capture_bank_booking_context(p_company_id, p_tx_ids);",
    "expected": 1
  },
  {
    "signature": "public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)",
    "old_text": "    IF v_tx_count = 1 THEN\n      UPDATE public.transactions\n      SET journal_entry_id = p_existing_journal_entry_id,",
    "new_text": "    IF EXISTS (\n      SELECT 1 FROM jsonb_array_elements(v_bank_context) c\n      GROUP BY c->>'settlement_account'\n      HAVING ABS(SUM((c->>'amount')::numeric) - COALESCE((\n        SELECT SUM(l.debit_amount - l.credit_amount)\n        FROM public.journal_entry_lines l\n        WHERE l.journal_entry_id = p_existing_journal_entry_id\n          AND l.account_number = c->>'settlement_account'\n      ), 0)) > 0.005\n    ) THEN\n      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';\n    END IF;\n\n    IF v_tx_count = 1 THEN\n      UPDATE public.transactions\n      SET journal_entry_id = p_existing_journal_entry_id,",
    "expected": 1
  },
  {
    "signature": "public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)",
    "old_text": "       entry_date, description, source_type, status)",
    "new_text": "       entry_date, description, source_type, status, bank_booking_context)",
    "expected": 1
  },
  {
    "signature": "public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)",
    "old_text": "       v_tx_date, v_entry_description, 'manual', 'draft');",
    "new_text": "       v_tx_date, v_entry_description, 'manual', 'draft', v_bank_context);",
    "expected": 1
  },
  {
    "signature": "public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)",
    "old_text": "    SELECT voucher_number INTO v_voucher_number\n    FROM public.commit_journal_entry",
    "new_text": "    IF EXISTS (\n      SELECT 1 FROM jsonb_array_elements(v_bank_context) c\n      GROUP BY c->>'settlement_account'\n      HAVING ABS(SUM((c->>'amount')::numeric) - COALESCE((\n        SELECT SUM(l.debit_amount - l.credit_amount)\n        FROM public.journal_entry_lines l\n        WHERE l.journal_entry_id = v_journal_entry_id\n          AND l.account_number = c->>'settlement_account'\n      ), 0)) > 0.005\n    ) THEN\n      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';\n    END IF;\n\n    SELECT voucher_number INTO v_voucher_number\n    FROM public.commit_journal_entry",
    "expected": 1
  },
  {
    "signature": "public.match_batch_allocate(uuid,jsonb,uuid,uuid)",
    "old_text": "  v_tx RECORD;",
    "new_text": "  v_tx RECORD;\n  v_bank_context jsonb;\n  v_bank_account text;",
    "expected": 1
  },
  {
    "signature": "public.match_batch_allocate(uuid,jsonb,uuid,uuid)",
    "old_text": "  INSERT INTO public.journal_entries\n",
    "new_text": "  v_bank_context := public.capture_bank_booking_context(p_company_id, ARRAY[p_tx_id]);\n  v_bank_account := v_bank_context #>> '{0,settlement_account}';\n\n  INSERT INTO public.journal_entries\n",
    "expected": 1
  },
  {
    "signature": "public.match_batch_allocate(uuid,jsonb,uuid,uuid)",
    "old_text": "     entry_date, description, source_type, status)",
    "new_text": "     entry_date, description, source_type, status, bank_booking_context)",
    "expected": 1
  },
  {
    "signature": "public.match_batch_allocate(uuid,jsonb,uuid,uuid)",
    "old_text": "     v_tx.date, v_entry_description, v_source_type, 'draft');",
    "new_text": "     v_tx.date, v_entry_description, v_source_type, 'draft', v_bank_context);",
    "expected": 1
  },
  {
    "signature": "public.match_batch_allocate(uuid,jsonb,uuid,uuid)",
    "old_text": "(v_journal_entry_id, '1930',",
    "new_text": "(v_journal_entry_id, v_bank_account,",
    "expected": 2
  },
  {
    "signature": "public.create_expense_payout_batch(uuid,uuid[],date,text,text,uuid,uuid)",
    "old_text": "     entry_date, description, source_type, source_id, status)",
    "new_text": "     entry_date, description, source_type, source_id, status, bank_booking_context)",
    "expected": 1
  },
  {
    "signature": "public.create_expense_payout_batch(uuid,uuid[],date,text,text,uuid,uuid)",
    "old_text": "     p_payout_date, v_desc, 'expense_payout', v_batch_id, 'draft');",
    "new_text": "     p_payout_date, v_desc, 'expense_payout', v_batch_id, 'draft',\n     CASE WHEN p_transaction_id IS NULL THEN '[]'::jsonb\n       ELSE public.capture_bank_booking_context(p_company_id, ARRAY[p_transaction_id]) END);",
    "expected": 1
  }
]
$patches$::jsonb)
  LOOP
    v_definition := replace(pg_get_functiondef((v_patch->>'signature')::regprocedure), E'\r\n', E'\n');
    v_old := v_patch->>'old_text';
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count <> (v_patch->>'expected')::integer THEN
      RAISE EXCEPTION 'Unexpected atomic booking definition: %, marker occurrences %', v_patch->>'signature', v_count;
    END IF;
    EXECUTE replace(v_definition, v_old, v_patch->>'new_text');
  END LOOP;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
