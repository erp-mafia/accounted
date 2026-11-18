-- Moving a bank account onto the ledger its history is on no longer times out
-- on a company with many verifikat (crm#1683, crm#1702).
--
-- What happened. A company imported its history (SIE, a few thousand posted
-- verifikat on a manual 1930 row), then connected the bank, whose account got
-- its own row on 1935 and about a thousand unbooked rows from the first
-- import. Moving the account to 1930 in the bank settings retires the 1935
-- row into the 1930 row (promote_psd2_cash_account), which moves every
-- unbooked row with UPDATE transactions ... WHERE cash_transaction_is_movable.
-- The save ran past the 8 s statement timeout of the authenticated role on
-- every attempt, and the user saw "Tillfälligt fel".
--
-- Why. "Is a posted verifikat naming this bank row" was asked as
--   j.company_id = $1 AND j.status = 'posted'
--   AND ((j.source_type = 'bank_transaction' AND j.source_id = $2)
--     OR j.bank_booking_context @> [{"transaction_id": $2}])
-- With $2 a parameter, the OR keeps the planner on the company index: every
-- probe reads every verifikat of the company (about 27 ms at 3,400 verifikat).
-- Moving one row asks it three times: cash_transaction_is_movable in the
-- UPDATE, again in guard_cash_transaction_binding, and once more in the
-- trigger's claim loop. 1,058 rows x 3 probes x 27 ms is well past 8 s.
--
-- What changes.
--   * public.posted_entries_naming_bank_row(company, transaction) asks the two
--     halves separately, each on its own index: the source half on
--     journal_entries_posted_bank_source_idx (company_id, source_id), the
--     context half on the GIN index journal_entries_posted_bank_context_idx,
--     with the company checked on the GIN hits (a company predicate inside
--     lets the planner AND in the company index, which is again every
--     verifikat of the company). SECURITY INVOKER: each caller keeps the rows
--     it could read before.
--   * cash_transaction_is_movable and guard_cash_transaction_binding use it in
--     place of the OR probe. Same rows, same refusals; every other line of
--     both functions is byte-identical to their definitions in
--     20260922121933 and 20261012100100 (both checked against production on
--     2026-11-07).
--   * The GIN index stops collecting a pending list (fastupdate = off) and
--     the list it holds is merged now. A lookup scans the whole pending list
--     (up to gin_pending_list_limit, 4 MB) before the index proper: a probe
--     that matched nothing then costs about as much as the scan it
--     replaces. With the list gone a probe reads a few pages. Inserts of
--     posted verifikat write the index directly instead.
--
-- pg-test: covered-by tests/pg/bank-row-claim-probes.pg.test.ts

CREATE OR REPLACE FUNCTION public.posted_entries_naming_bank_row(p_company_id uuid, p_transaction_id uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  -- The verifikat the bank row is the source of.
  RETURN QUERY SELECT j.id FROM public.journal_entries j
    WHERE j.company_id = p_company_id AND j.status = 'posted'
      AND j.source_type = 'bank_transaction' AND j.source_id = p_transaction_id;
  -- The verifikat whose bank booking context names the bank row. GIN lookup
  -- first, the company on its hits: OFFSET 0 keeps the company predicate out
  -- of the scan, where the planner would AND in the company index.
  RETURN QUERY SELECT x.id FROM (
      SELECT j.id, j.company_id FROM public.journal_entries j
      WHERE j.status = 'posted'
        AND j.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', p_transaction_id))
      OFFSET 0
    ) x
    WHERE x.company_id = p_company_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.posted_entries_naming_bank_row(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.posted_entries_naming_bank_row(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cash_transaction_is_movable(p_company_id uuid, p_transaction_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = p_transaction_id AND t.company_id = p_company_id
      AND t.journal_entry_id IS NULL AND t.invoice_id IS NULL AND t.supplier_invoice_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM public.invoice_payments a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_payments a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM public.posted_entries_naming_bank_row(p_company_id, t.id))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_cash_transaction_binding()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_binding_changed boolean := false;
  v_ledger text;
  v_entry uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'BANK_ANCHOR_COMPANY_CHANGED' USING ERRCODE = '23514';
    END IF;
    v_binding_changed := NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id;
    IF NOT v_binding_changed
      AND (NEW.journal_entry_id IS NULL OR NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id)
      AND (NEW.invoice_id IS NULL OR NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id)
      AND (NEW.supplier_invoice_id IS NULL OR NEW.supplier_invoice_id IS NOT DISTINCT FROM OLD.supplier_invoice_id)
    THEN RETURN NEW; END IF;
  ELSIF NEW.journal_entry_id IS NULL AND NEW.invoice_id IS NULL AND NEW.supplier_invoice_id IS NULL THEN
    -- Ordinary source inserts keep the FK/ingest protocol. No new anchor is
    -- attached here, and taking a company lock would invert ingest's order.
    RETURN NEW;
  END IF;

  PERFORM public.observe_cash_account_company(NEW.company_id);
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  IF v_binding_changed AND OLD.cash_account_id IS NOT NULL
     AND NOT public.cash_transaction_is_movable(OLD.company_id, OLD.id)
     AND NOT (
       OLD.journal_entry_id IS NOT NULL
       AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       AND EXISTS (SELECT 1 FROM public.journal_entries j
         WHERE j.company_id = OLD.company_id AND j.id = OLD.journal_entry_id
           AND j.status IN ('draft', 'cancelled', 'reversed'))
       AND EXISTS (SELECT 1 FROM public.journal_entries j
         WHERE j.company_id = NEW.company_id AND j.id = NEW.journal_entry_id AND j.status = 'posted')
       AND OLD.invoice_id IS NULL AND OLD.supplier_invoice_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links a WHERE a.transaction_id = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM public.invoice_payments a WHERE a.transaction_id = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_payments a WHERE a.transaction_id = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM public.posted_entries_naming_bank_row(OLD.company_id, OLD.id))
     ) THEN
    RAISE EXCEPTION 'BANK_ANCHOR_BINDING_IN_USE' USING ERRCODE = 'PT409';
  END IF;
  v_ledger := public.bank_anchor_settlement_account(NEW.company_id, NEW.cash_account_id, NEW.currency);

  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.invoices WHERE company_id = NEW.company_id AND id = NEW.invoice_id
  ) THEN RAISE EXCEPTION 'BANK_ANCHOR_INVOICE_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  IF NEW.supplier_invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.supplier_invoices WHERE company_id = NEW.company_id AND id = NEW.supplier_invoice_id
  ) THEN RAISE EXCEPTION 'BANK_ANCHOR_INVOICE_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  PERFORM public.assert_bank_anchor_journal(NEW.company_id, NEW.id, NEW.journal_entry_id, v_ledger, NEW.amount, true);

  IF v_binding_changed THEN
    -- NULL-to-cash adoption must preserve every existing bank claim, including
    -- a posted origin whose final payment/direct/junction link has not arrived.
    FOR v_entry IN
      SELECT journal_entry_id FROM public.transaction_voucher_links
        WHERE company_id = NEW.company_id AND transaction_id = NEW.id AND role = 'bank_line'
      UNION SELECT journal_entry_id FROM public.invoice_payments
        WHERE company_id = NEW.company_id AND transaction_id = NEW.id
      UNION SELECT journal_entry_id FROM public.supplier_invoice_payments
        WHERE company_id = NEW.company_id AND transaction_id = NEW.id
      UNION SELECT e FROM public.posted_entries_naming_bank_row(NEW.company_id, NEW.id) e
    LOOP
      PERFORM public.assert_bank_anchor_journal(NEW.company_id, NEW.id, v_entry, v_ledger, NEW.amount, true);
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$
;

ALTER INDEX public.journal_entries_posted_bank_context_idx SET (fastupdate = off);
SELECT pg_catalog.gin_clean_pending_list('public.journal_entries_posted_bank_context_idx'::regclass);
