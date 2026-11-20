-- Restate in full the 20 functions whose current text existed in the
-- repository only as an original CREATE plus later replace() patches.
--
-- 19 migrations (20260703180000 through 20261011140000) changed function
-- bodies by reading pg_get_functiondef, running replace() on fragments of it
-- and executing the result. Each patch refused a body it did not recognise,
-- so none of them was unsafe on its own, but the code that runs ended up in
-- no file: a reader had to replay the chain of fragments in their head, a
-- review saw only the fragments, and the next patch had to match text nobody
-- could grep for.
--
-- Each definition below is pg_get_functiondef output, byte for byte, taken
-- from a replay of every migration up to 20261012030700. For 19 of them the
-- text is the one whose md5 was checked equal to production's on 2026-10-11;
-- bulk_book_transactions is the body 20261011140000 patched since. Applying
-- this file changes nothing in a database that ran the earlier migrations:
-- md5(pg_get_functiondef), owner, ACL, SECURITY DEFINER and search_path are
-- the same before and after, since CREATE OR REPLACE keeps owner, grants and
-- comment. The text is kept verbatim so the comparison stays exact,
-- including three em dashes inside
-- plpgsql comments and the unqualified RETURNS company_inboxes (resolved
-- through the migration session's search_path, as when production printed
-- it). Each statement's semicolon stands on the line after the closing
-- delimiter, so every block is exactly what pg_get_functiondef prints.
--
-- reserve_voucher_range, release_voucher_range and company_has_capability
-- were patched the same way and are left out: a separate change drops them.
-- insert_bank_transaction was patched the same way until
-- 20261011135800_bank_transaction_raw_inputs restated it in full; it is left
-- out too, since restating the older body here would revert that change.
--
-- From here on a function changes through a full CREATE OR REPLACE FUNCTION,
-- copied from the newest migration that defines it (this file, for these 20)
-- and edited there. check:guards (functiondef-patch) fails a new migration
-- that calls pg_get_functiondef.
--
-- pg-test: tests/pg/restated-functions.pg.test.ts

-- public.assert_bank_anchor_journal: last full definition in 20260921183218_guard_cash_transaction_anchors, then patched by 20260922102109.
CREATE OR REPLACE FUNCTION public.assert_bank_anchor_journal(p_company_id uuid, p_transaction_id uuid, p_journal_entry_id uuid, p_settlement_account text, p_amount numeric, p_bank_line boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_context jsonb;
BEGIN
  IF p_journal_entry_id IS NULL THEN RETURN; END IF;
  SELECT bank_booking_context INTO v_context FROM public.journal_entries
    WHERE company_id = p_company_id AND id = p_journal_entry_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_ANCHOR_JOURNAL_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  IF NOT p_bank_line THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_context) c
    WHERE c->>'transaction_id' = p_transaction_id::text
      AND c->>'settlement_account' IS DISTINCT FROM p_settlement_account
  ) OR NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id AND l.account_number = p_settlement_account
      AND ((p_amount < 0 AND l.credit_amount > 0) OR (p_amount > 0 AND l.debit_amount > 0)
        OR (p_amount = 0 AND (l.credit_amount > 0 OR l.debit_amount > 0)))
  ) THEN
    RAISE EXCEPTION 'BANK_ANCHOR_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
END;
$function$
;

-- public.attach_supplier_invoice_settlement_voucher: last full definition in 20260922085025_restore_missing_supplier_settlement_prerequisites, then patched by 20260922090239, 20260922090639.
CREATE OR REPLACE FUNCTION public.attach_supplier_invoice_settlement_voucher(p_supplier_invoice_id uuid, p_journal_entry_id uuid, p_user_id uuid, p_company_id uuid, p_notes text DEFAULT NULL::text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_voucher RECORD;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
  v_accounting_method text;
  v_settled numeric;
  v_explained numeric;
  v_unexplained numeric;
  v_matched numeric;
  v_used numeric;
  v_capacity numeric;
  v_payment_id uuid;
  -- An explicit NULL fails safe: nothing is written and the result says so.
  -- Left raw, `IF NOT NULL` would skip the INSERT and still answer ok, which
  -- reads as a write that never happened.
  v_dry_run boolean := COALESCE(p_dry_run, true);
BEGIN
  -- Attribution, as in link_supplier_invoice_to_voucher: for a user session the
  -- JWT sub is authoritative, so p_user_id cannot point the row at someone else.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTACH_SI_SETTLEMENT_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

  -- Serialise on the verifikat first, then on the invoice row. Two invoices
  -- attaching to one batch-payment verifikat at the same moment would otherwise
  -- both pass the capacity check below. The order is fixed (verifikat, then
  -- invoice) and link_supplier_invoice_to_voucher takes the invoice row lock
  -- only, so no two callers can wait on each other in a cycle.
  BEGIN
    PERFORM public.lock_cash_account_company(p_company_id);
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND');
  END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('si-settlement-voucher:' || p_journal_entry_id::text, 0)
  );

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND');
  END IF;

  SELECT id, status, source_type, entry_date, reversed_by_id INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_FOUND');
  END IF;

  -- Before every state check, so a batch that is run twice reports the pair as
  -- already attached instead of as an invoice with nothing left to explain.
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND supplier_invoice_id = p_supplier_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED');
  END IF;

  -- Before the status check, so a credit note always gets this answer. The
  -- supplier_invoices_credit_note_not_payable constraint keeps a new credit
  -- note out of 'paid', but it is NOT VALID: a row that predates it can still
  -- stand as a paid credit note, and must not slip through as an invoice.
  IF COALESCE(v_invoice.is_credit_note, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CREDIT_NOTE_UNSUPPORTED');
  END IF;

  -- An open invoice is link_supplier_invoice_to_voucher's business: that one
  -- records the payment. This one only explains a settlement that already stands.
  IF v_invoice.status NOT IN ('paid', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOT_SETTLED',
      'details', jsonb_build_object('status', v_invoice.status));
  END IF;

  IF COALESCE(v_invoice.currency, 'SEK') <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CURRENCY_UNSUPPORTED',
      'details', jsonb_build_object('invoice_currency', v_invoice.currency));
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status));
  END IF;

  -- reverseEntry() flips a cancelled verifikat to status 'reversed', which the
  -- check above already refuses; reversed_by_id is read as well so a cancelled
  -- verifikat can never pass on the status alone.
  IF v_voucher.reversed_by_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE',
      'details', jsonb_build_object('reason', 'reversed'));
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE',
      'details', jsonb_build_object('reason', 'source_type', 'source_type', v_voucher.source_type));
  END IF;

  -- A closed or locked period is NOT a reason to refuse: the row is reskontra,
  -- no verifikat is written or changed, and the payments this exists for sit in
  -- imported years that are closed by nature (link_supplier_invoice_to_voucher
  -- allows a locked period on the same ground). What must not happen is that a
  -- figure already ACTED ON shifts silently. A posted kontantmetoden cut-off for
  -- a year ending on E counted this invoice as a skuld when the invoice is
  -- dated on or before E and no payment on or before E was known. Evidence
  -- dated on or before E would make a recomputation disagree with that posted
  -- verifikat, with no rättelse to say why. So it is refused: the wrong cut-off
  -- is corrected first (storno the pair, which then reads as absent here exactly
  -- as it does in inspectKontantmetodCutoffPostings, and post it again).
  -- Evidence dated after E leaves that cut-off right and passes.
  IF EXISTS (
    SELECT 1
    FROM public.kontantmetod_cutoff_entries k
    JOIN public.journal_entries cje ON cje.id = k.journal_entry_id
    JOIN public.fiscal_periods fp ON fp.id = k.fiscal_period_id
    WHERE k.company_id = p_company_id
      AND k.kind = 'payable'
      AND cje.status = 'posted'
      AND fp.period_end >= v_voucher.entry_date
      AND fp.period_end >= v_invoice.invoice_date
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CUTOFF_ALREADY_POSTED',
      'details', jsonb_build_object(
        'voucher_date', v_voucher.entry_date,
        'invoice_date', v_invoice.invoice_date
      ));
  END IF;

  -- What stands as settled. 'paid' means the whole total by definition of the
  -- status, and the total is also what the cut-off measures the rows against;
  -- 'partially_paid' is settled to the extent paid_amount says.
  v_settled := ROUND((CASE WHEN v_invoice.status = 'paid'
                           THEN COALESCE(v_invoice.total, 0)
                           ELSE COALESCE(v_invoice.paid_amount, 0) END) * 100) / 100;

  SELECT COALESCE(SUM(amount), 0) INTO v_explained
  FROM public.supplier_invoice_payments
  WHERE company_id = p_company_id
    AND supplier_invoice_id = p_supplier_invoice_id;
  v_explained := ROUND(v_explained * 100) / 100;

  v_unexplained := ROUND((v_settled - v_explained) * 100) / 100;
  IF v_unexplained <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOTHING_TO_EXPLAIN',
      'details', jsonb_build_object('settled', v_settled, 'explained', v_explained));
  END IF;

  -- The settlement side, by accounting method (defaults to accrual when there
  -- is no settings row, as in link_invoice_to_voucher).
  SELECT cs.accounting_method INTO v_accounting_method
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  v_accounting_method := COALESCE(v_accounting_method, 'accrual');

  IF v_accounting_method = 'cash' THEN
    -- Kontantmetoden: the paying verifikat credits a liquid-funds account (19xx).
    SELECT COALESCE(SUM(credit_amount), 0) INTO v_matched
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '19%'
      AND credit_amount > 0;
  ELSE
    -- Faktureringsmetoden: the paying verifikat debits leverantörsskulder (244x).
    SELECT COALESCE(SUM(debit_amount), 0) INTO v_matched
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '244%'
      AND debit_amount > 0;
  END IF;
  v_matched := ROUND(v_matched * 100) / 100;

  IF v_matched <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE',
      'details', jsonb_build_object(
        'accounting_method', v_accounting_method,
        'expected', CASE WHEN v_accounting_method = 'cash' THEN '19xx credit' ELSE '244x debit' END
      ));
  END IF;

  -- A row in another currency on the same verifikat has used an amount of the
  -- kronor side that cannot be read off the row, so the capacity is unknown.
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND journal_entry_id = p_journal_entry_id
      AND COALESCE(currency, 'SEK') <> 'SEK'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_CURRENCY_UNSUPPORTED');
  END IF;

  -- Every row already pointing at this verifikat, whichever invoice and
  -- whichever path wrote it, has used part of its settlement side.
  SELECT COALESCE(SUM(amount), 0) INTO v_used
  FROM public.supplier_invoice_payments
  WHERE company_id = p_company_id
    AND journal_entry_id = p_journal_entry_id;
  v_used := ROUND(v_used * 100) / 100;

  v_capacity := ROUND((v_matched - v_used) * 100) / 100;
  IF v_unexplained > v_capacity + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER',
      'details', jsonb_build_object(
        'unexplained', v_unexplained,
        'voucher_settlement_side', v_matched,
        'already_attached', v_used,
        'capacity', v_capacity
      ));
  END IF;

  IF NOT v_dry_run THEN
    -- The fixed prefix marks every row this function wrote, so one run can be
    -- found and undone with a single DELETE (same idea as backfill:#2019).
    INSERT INTO public.supplier_invoice_payments (
      user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
      journal_entry_id, transaction_id, notes
    ) VALUES (
      v_acting_user, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
      v_unexplained, 'SEK', p_journal_entry_id, NULL,
      'settlement-evidence' || CASE WHEN p_notes IS NULL THEN '' ELSE ': ' || p_notes END
    )
    RETURNING id INTO v_payment_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', v_dry_run,
    'payment_id', v_payment_id,
    'supplier_invoice_id', p_supplier_invoice_id,
    'journal_entry_id', p_journal_entry_id,
    'payment_date', v_voucher.entry_date,
    'amount', v_unexplained,
    'settled', v_settled,
    'explained_before', v_explained,
    'voucher_settlement_side', v_matched,
    'voucher_capacity_after', ROUND((v_capacity - v_unexplained) * 100) / 100
  );
END;
$function$
;

-- public.bind_bank_transaction: last full definition in 20260921160410_guard_bank_transaction_adoption, then patched by 20260921174830.
CREATE OR REPLACE FUNCTION public.bind_bank_transaction(p_company_id uuid, p_connection_id uuid, p_account_uid text, p_currency text, p_route_token text, p_transaction_id uuid, p_expected_date date, p_expected_amount numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_route jsonb;
  v_transaction public.transactions;
  v_destination public.cash_accounts;
  v_existing public.cash_accounts;
  v_entry_id uuid;
BEGIN
  v_route := public.resolve_bank_ingest_route(p_company_id, p_connection_id, p_account_uid, p_currency, true);
  IF p_route_token IS DISTINCT FROM v_route->>'token' THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO v_destination FROM public.cash_accounts WHERE id = (v_route->>'cashAccountId')::uuid AND company_id = p_company_id;
  SELECT * INTO v_transaction FROM public.transactions WHERE id = p_transaction_id AND company_id = p_company_id FOR UPDATE;
  IF v_transaction.id IS NULL OR upper(v_transaction.currency) IS DISTINCT FROM upper(p_currency)
     OR v_transaction.date IS DISTINCT FROM p_expected_date OR v_transaction.amount IS DISTINCT FROM p_expected_amount THEN
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF v_transaction.cash_account_id IS NOT NULL THEN
    IF v_transaction.cash_account_id = v_destination.id THEN RETURN v_destination.id; END IF;
    SELECT * INTO v_existing FROM public.cash_accounts WHERE id = v_transaction.cash_account_id AND company_id = p_company_id;
    -- Another writer may have bound the row to a retained twin. The same
    -- physical account is still a valid dedup match; never overwrite its anchor.
    IF nullif(regexp_replace(v_existing.iban, '\s', '', 'g'), '') IS NOT NULL
       AND upper(regexp_replace(v_existing.iban, '\s', '', 'g')) = upper(regexp_replace(v_destination.iban, '\s', '', 'g'))
       AND upper(v_existing.currency) = upper(v_destination.currency) THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  -- The candidate was a manual row. If it became a feed row while this batch
  -- was deduplicating, the caller must reconsider the match on a fresh read.
  IF v_transaction.bank_connection_id IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  -- Revalidate accounting anchors AFTER locking the transaction. An earlier
  -- application-side read cannot prove which ledger an anchor now explains.
  FOR v_entry_id IN
    SELECT v_transaction.journal_entry_id WHERE v_transaction.journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM public.transaction_voucher_links
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id AND role = 'bank_line'
    UNION SELECT journal_entry_id FROM public.invoice_payments
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id
    UNION SELECT journal_entry_id FROM public.supplier_invoice_payments
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id
  LOOP
    IF v_entry_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.journal_entries j JOIN public.journal_entry_lines l ON l.journal_entry_id = j.id
       WHERE j.company_id = p_company_id AND j.id = v_entry_id AND l.account_number = v_destination.ledger_account
    ) THEN
      RAISE EXCEPTION 'BANK_INGEST_ADOPTION_ANCHOR_CHANGED' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;
  UPDATE public.transactions SET cash_account_id = v_destination.id
   WHERE id = p_transaction_id AND company_id = p_company_id AND cash_account_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409'; END IF;
  RETURN v_destination.id;
END;
$function$
;

-- public.bulk_book_transactions: last full definition in 20260824170000_bulk_book_transactions_service_actor, then patched by 20260921180432, 20260921180555, 20261010200000, 20261011140000.
CREATE OR REPLACE FUNCTION public.bulk_book_transactions(p_tx_ids uuid[], p_existing_journal_entry_id uuid, p_new_entry jsonb, p_company_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_commit_method text DEFAULT NULL::text, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx RECORD;
  v_bank_context jsonb;
  -- The ledgers the selected rows settle on (v_bank_context), and whether any
  -- of them is a 19xx account: together they say which lines are the bank side.
  v_bank_ledgers text[];
  v_bank_ledger_in_19xx boolean;
  v_tx_date date;
  v_total_amount numeric := 0;
  v_total_amount_abs numeric;
  v_direction text;
  v_tx_count int := 0;

  -- Currency homogeneity (BFL 4 kap 6 §). A separate "seen" flag rather
  -- than a NULL check on v_currency: the first row's currency can itself
  -- be NULL, and that must still pin the batch to SEK for the rest.
  v_currency text;
  v_currency_seen boolean := false;

  v_voucher RECORD;
  v_voucher_bank_net numeric := 0;

  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;

  v_journal_entry_id uuid;
  v_voucher_series text := 'A';
  v_voucher_number int;
  v_entry_description text;

  v_line jsonb;
  v_line_account text;
  v_line_debit numeric;
  v_line_credit numeric;
  v_line_currency text;
  v_line_dims jsonb;
  v_lines_total_debit numeric := 0;
  v_lines_total_credit numeric := 0;
  v_lines_bank_net numeric := 0;
  v_sort_order int := 0;

  v_docs_linked int := 0;
  v_target_je uuid;

  v_invalid_accounts text[];

  v_now timestamptz := now();
  v_caller uuid;
BEGIN
  -- Actor resolution. p_user_id is an assertion by the caller, so it is
  -- honored only for the service role (the pending-operations commit path
  -- runs on createServiceClientNoCookies, where auth.uid() is NULL). Any
  -- other caller is pinned to its own auth.uid(): an authenticated
  -- PostgREST caller cannot impersonate another member. Mirrors
  -- match_batch_allocate (20260817150000) and undo_sie_import.
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_UNAUTHORIZED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = v_caller AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_UNAUTHORIZED');
  END IF;

  IF p_tx_ids IS NULL OR array_length(p_tx_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_TXS');
  END IF;

  IF (p_existing_journal_entry_id IS NULL AND p_new_entry IS NULL)
     OR (p_existing_journal_entry_id IS NOT NULL AND p_new_entry IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_INVALID_PAYLOAD');
  END IF;

  PERFORM public.lock_cash_account_booking_state(p_company_id);

  FOR v_tx IN
    SELECT * FROM public.transactions
    WHERE id = ANY(p_tx_ids) AND company_id = p_company_id
    ORDER BY id
    FOR UPDATE
  LOOP
    v_tx_count := v_tx_count + 1;
    IF v_tx.journal_entry_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TX_ALREADY_BOOKED',
        'details', jsonb_build_object('tx_id', v_tx.id));
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.transaction_voucher_links tvl
      WHERE tvl.transaction_id = v_tx.id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TX_ALREADY_BOOKED',
        'details', jsonb_build_object('tx_id', v_tx.id, 'via', 'transaction_voucher_links'));
    END IF;
    IF v_tx.amount = 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TX_ZERO_AMOUNT',
        'details', jsonb_build_object('tx_id', v_tx.id));
    END IF;

    IF v_tx_date IS NULL THEN
      v_tx_date := v_tx.date;
    ELSIF v_tx_date <> v_tx.date THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_DATE_MISMATCH',
        'details', jsonb_build_object('first_date', v_tx_date, 'other_date', v_tx.date));
    END IF;

    -- Mixed currencies cannot be added into v_total_amount below.
    IF NOT v_currency_seen THEN
      v_currency := COALESCE(v_tx.currency, 'SEK');
      v_currency_seen := true;
    ELSIF v_currency <> COALESCE(v_tx.currency, 'SEK') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_MIXED_CURRENCY',
        'details', jsonb_build_object(
          'currencies', jsonb_build_array(v_currency, COALESCE(v_tx.currency, 'SEK'))));
    END IF;

    IF v_direction IS NULL THEN
      v_direction := CASE WHEN v_tx.amount > 0 THEN 'income' ELSE 'expense' END;
    ELSIF (v_direction = 'income' AND v_tx.amount < 0)
       OR (v_direction = 'expense' AND v_tx.amount > 0) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_DIRECTION_MISMATCH',
        'details', jsonb_build_object('expected', v_direction, 'tx_id', v_tx.id));
    END IF;

    v_total_amount := v_total_amount + v_tx.amount;
  END LOOP;

  IF v_tx_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TXS_NOT_FOUND');
  END IF;

  IF v_tx_count <> COALESCE(array_length(p_tx_ids, 1), 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TXS_NOT_FOUND',
      'details', jsonb_build_object('expected', array_length(p_tx_ids, 1), 'found', v_tx_count));
  END IF;

  -- A homogeneous foreign batch is refused too. The debit/credit columns
  -- written below are ALWAYS kronor and this function has no exchange rate:
  -- letting a EUR selection through would post its foreign magnitudes as SEK
  -- and every downstream reader (balansräkning, moms, SIE) would state an
  -- amount matching no affärshändelse. Foreign transactions are booked one at
  -- a time through the FX-aware flows instead.
  IF COALESCE(v_currency, 'SEK') <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_FOREIGN_CURRENCY',
      'details', jsonb_build_object('currency', v_currency));
  END IF;

  v_total_amount_abs := ABS(v_total_amount);
  v_bank_context := public.capture_bank_booking_context(p_company_id, p_tx_ids);

  SELECT array_agg(DISTINCT c->>'settlement_account'),
         COALESCE(bool_or(length(c->>'settlement_account') = 4
                          AND c->>'settlement_account' BETWEEN '1900' AND '1999'), false)
    INTO v_bank_ledgers, v_bank_ledger_in_19xx
  FROM jsonb_array_elements(v_bank_context) c;

  IF p_existing_journal_entry_id IS NOT NULL THEN
    SELECT * INTO v_voucher FROM public.journal_entries
    WHERE id = p_existing_journal_entry_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_JE_NOT_FOUND',
        'details', jsonb_build_object('journal_entry_id', p_existing_journal_entry_id));
    END IF;

    IF v_voucher.status <> 'posted' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_JE_NOT_POSTED',
        'details', jsonb_build_object('status', v_voucher.status));
    END IF;

    SELECT COALESCE(SUM(debit_amount - credit_amount), 0) INTO v_voucher_bank_net
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_existing_journal_entry_id
      AND (account_number = ANY(v_bank_ledgers)
        OR (v_bank_ledger_in_19xx
          AND length(account_number) = 4
          AND account_number BETWEEN '1900' AND '1999'));

    IF ABS(v_voucher_bank_net - v_total_amount) > 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_AMOUNT_MISMATCH',
        'details', jsonb_build_object(
          'tx_sum', v_total_amount, 'voucher_bank_net', v_voucher_bank_net));
    END IF;

    FOR v_tx IN
      SELECT * FROM public.transactions
      WHERE id = ANY(p_tx_ids) AND company_id = p_company_id
      ORDER BY id
    LOOP
      INSERT INTO public.transaction_voucher_links
        (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
      VALUES
        (v_caller, p_company_id, v_tx.id, p_existing_journal_entry_id, v_tx.amount, 'bank_line');
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM (
        SELECT c->>'settlement_account' AS ledger, SUM((c->>'amount')::numeric) AS amount
        FROM jsonb_array_elements(v_bank_context) c
        GROUP BY c->>'settlement_account'
      ) bank_totals
      WHERE ABS(bank_totals.amount - COALESCE((
        SELECT SUM(l.debit_amount - l.credit_amount)
        FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = p_existing_journal_entry_id
          AND l.account_number = bank_totals.ledger
      ), 0)) > 0.005
    ) THEN
      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';
    END IF;

    IF v_tx_count = 1 THEN
      UPDATE public.transactions
      SET journal_entry_id = p_existing_journal_entry_id,
          reconciliation_method = 'manual',
          is_business = TRUE,
          updated_at = v_now
      WHERE id = p_tx_ids[1];
    ELSE
      UPDATE public.transactions
      SET is_business = TRUE, updated_at = v_now
      WHERE id = ANY(p_tx_ids);
    END IF;

    v_target_je := p_existing_journal_entry_id;
    v_voucher_series := v_voucher.voucher_series;
    v_voucher_number := v_voucher.voucher_number;

  ELSE
    v_entry_description := p_new_entry->>'description';
    IF v_entry_description IS NULL OR LENGTH(TRIM(v_entry_description)) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_MISSING_DESCRIPTION');
    END IF;

    IF jsonb_typeof(p_new_entry->'lines') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_new_entry->'lines') < 2 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_LINES');
    END IF;

    WITH submitted AS (
      SELECT DISTINCT value->>'account_number' AS acct
      FROM jsonb_array_elements(p_new_entry->'lines')
    )
    SELECT array_agg(s.acct ORDER BY s.acct) INTO v_invalid_accounts
    FROM submitted s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts coa
      WHERE coa.account_number = s.acct
        AND coa.company_id = p_company_id
        AND coa.is_active = true
    );
    IF v_invalid_accounts IS NOT NULL AND array_length(v_invalid_accounts, 1) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_INVALID_ACCOUNT',
        'details', jsonb_build_object('invalid_accounts', v_invalid_accounts));
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_entry->'lines')
    LOOP
      v_line_account := v_line->>'account_number';
      v_line_debit := COALESCE((v_line->>'debit_amount')::numeric, 0);
      v_line_credit := COALESCE((v_line->>'credit_amount')::numeric, 0);
      IF v_line_debit < 0 OR v_line_credit < 0 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NEGATIVE_LINE',
          'details', jsonb_build_object('account', v_line_account));
      END IF;
      IF v_line_debit > 0 AND v_line_credit > 0 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_BOTH_SIDES_NONZERO',
          'details', jsonb_build_object('account', v_line_account));
      END IF;
      IF v_line ? 'dimensions'
         AND jsonb_typeof(v_line->'dimensions') IS DISTINCT FROM 'object' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_INVALID_DIMENSIONS',
          'details', jsonb_build_object('account', v_line_account));
      END IF;
      v_lines_total_debit := v_lines_total_debit + v_line_debit;
      v_lines_total_credit := v_lines_total_credit + v_line_credit;
      IF v_line_account = ANY(v_bank_ledgers)
         OR (v_bank_ledger_in_19xx
           AND length(v_line_account) = 4 AND v_line_account BETWEEN '1900' AND '1999') THEN
        v_lines_bank_net := v_lines_bank_net + v_line_debit - v_line_credit;
      END IF;
    END LOOP;

    IF ABS(v_lines_total_debit - v_lines_total_credit) > 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_UNBALANCED',
        'details', jsonb_build_object(
          'debit_sum', v_lines_total_debit, 'credit_sum', v_lines_total_credit));
    END IF;

    IF ABS(v_lines_bank_net - v_total_amount) > 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_AMOUNT_MISMATCH',
        'details', jsonb_build_object(
          'tx_sum', v_total_amount,
          'lines_bank_net', v_lines_bank_net));
    END IF;

    SELECT id, is_closed, locked_at INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
    FROM public.fiscal_periods
    WHERE company_id = p_company_id AND v_tx_date BETWEEN period_start AND period_end
    ORDER BY period_start DESC LIMIT 1;

    IF v_fiscal_period_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_FISCAL_PERIOD',
        'details', jsonb_build_object('tx_date', v_tx_date));
    END IF;

    IF v_period_is_closed OR v_period_locked_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_PERIOD_LOCKED',
        'details', jsonb_build_object('fiscal_period_id', v_fiscal_period_id));
    END IF;

    v_journal_entry_id := gen_random_uuid();

    INSERT INTO public.journal_entries
      (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
       entry_date, description, source_type, status, bank_booking_context)
    VALUES
      (v_journal_entry_id, v_caller, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
       v_tx_date, v_entry_description, 'manual', 'draft', v_bank_context);

    v_sort_order := 0;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_entry->'lines')
    LOOP
      v_line_account := v_line->>'account_number';
      v_line_debit := COALESCE((v_line->>'debit_amount')::numeric, 0);
      v_line_credit := COALESCE((v_line->>'credit_amount')::numeric, 0);
      v_line_currency := COALESCE(v_line->>'currency', 'SEK');

      -- Bag normalization as before (DimensionsBagSchema parity). PR9: the
      -- generated mirrors derive from the stored bag: no explicit columns.
      SELECT COALESCE(jsonb_object_agg(d.key, btrim(d.value)), '{}'::jsonb)
        INTO v_line_dims
      FROM jsonb_each_text(COALESCE(v_line->'dimensions', '{}'::jsonb)) AS d
      WHERE d.key ~ '^[1-9][0-9]*$' AND btrim(d.value) <> '';

      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_journal_entry_id, v_line_account, v_line_debit, v_line_credit, v_line_currency,
         COALESCE((v_line->>'sort_order')::int, v_sort_order),
         v_line->>'line_description',
         v_line_dims);

      v_sort_order := v_sort_order + 1;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM (
        SELECT c->>'settlement_account' AS ledger, SUM((c->>'amount')::numeric) AS amount
        FROM jsonb_array_elements(v_bank_context) c
        GROUP BY c->>'settlement_account'
      ) bank_totals
      WHERE ABS(bank_totals.amount - COALESCE((
        SELECT SUM(l.debit_amount - l.credit_amount)
        FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = v_journal_entry_id
          AND l.account_number = bank_totals.ledger
      ), 0)) > 0.005
    ) THEN
      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';
    END IF;

    SELECT voucher_number INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id, v_journal_entry_id, p_commit_method, NULL, p_actor_type, p_actor_label);

    FOR v_tx IN
      SELECT * FROM public.transactions
      WHERE id = ANY(p_tx_ids) AND company_id = p_company_id
      ORDER BY id
    LOOP
      INSERT INTO public.transaction_voucher_links
        (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
      VALUES
        (v_caller, p_company_id, v_tx.id, v_journal_entry_id, v_tx.amount, 'bank_line');
    END LOOP;

    IF v_tx_count = 1 THEN
      UPDATE public.transactions
      SET journal_entry_id = v_journal_entry_id,
          is_business = TRUE,
          updated_at = v_now
      WHERE id = p_tx_ids[1];
    ELSE
      UPDATE public.transactions
      SET is_business = TRUE, updated_at = v_now
      WHERE id = ANY(p_tx_ids);
    END IF;

    v_target_je := v_journal_entry_id;
  END IF;

  WITH linked AS (
    UPDATE public.document_attachments AS d
    SET journal_entry_id = v_target_je,
        updated_at = v_now
    FROM public.transactions AS t
    WHERE t.id = ANY(p_tx_ids)
      AND t.company_id = p_company_id
      AND t.document_id = d.id
      AND d.company_id = p_company_id
      AND d.journal_entry_id IS NULL
    RETURNING d.id
  )
  SELECT COUNT(*)::int INTO v_docs_linked FROM linked;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', CASE WHEN p_existing_journal_entry_id IS NOT NULL THEN 'link_existing' ELSE 'create_new' END,
    'journal_entry_id', v_target_je,
    'voucher_series', v_voucher_series,
    'voucher_number', v_voucher_number,
    'linked_tx_count', v_tx_count,
    'tx_sum', v_total_amount,
    'docs_linked', v_docs_linked
  );
END;
$function$
;

-- public.capture_bank_booking_context: last full definition in 20260921180432_coordinate_atomic_bank_booking_writers, then patched by 20260921180820.
CREATE OR REPLACE FUNCTION public.capture_bank_booking_context(p_company_id uuid, p_transaction_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
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
          AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF NOT FOUND THEN
        RAISE EXCEPTION 'BANK_BOOKING_CASH_ACCOUNT_MISSING' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT count(*), min(ledger_account) INTO v_count, v_ledger
        FROM public.cash_accounts
        WHERE company_id = p_company_id AND enabled AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF v_count <> 1 THEN v_ledger := '1930'; END IF;
    END IF;
    v_context := v_context || jsonb_build_array(jsonb_build_object(
      'transaction_id', v_transaction.id, 'cash_account_id', v_transaction.cash_account_id,
      'date', to_char(v_transaction.date, 'YYYY-MM-DD'), 'amount', v_transaction.amount,
      'currency', COALESCE(v_transaction.currency, 'SEK'), 'settlement_account', v_ledger
    ));
  END LOOP;
  IF v_seen <> cardinality(p_transaction_ids) THEN
    RAISE EXCEPTION 'BANK_BOOKING_SOURCE_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  RETURN v_context;
END;
$function$
;

-- public.commit_asset_disposal: last full definition in 20260803226000_atomic_asset_disposal, then patched by 20260921180432.
CREATE OR REPLACE FUNCTION public.commit_asset_disposal(p_company_id uuid, p_asset_id uuid, p_entry_id uuid, p_fiscal_period_id uuid, p_disposal_type text, p_disposed_at date, p_disposed_proceeds numeric, p_proceeds_vat numeric, p_vat_treatment text, p_current_depreciation numeric, p_jamkning_amount numeric, p_jamkning_direction text, p_jamkning_remaining_years integer, p_jamkning_total_years integer, p_jamkning_original_input_vat numeric, p_jamkning_original_deduction_percent numeric, p_jamkning_new_deduction_percent numeric, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS TABLE(voucher_number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_asset_user_id uuid;
  v_entry_user_id uuid;
  v_schedule_id uuid;
  v_schedule_entry_id uuid;
  v_period_start date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- NULL-safe membership guard (20260703180000): never the raw
  -- "NOT IN (SELECT user_company_ids())" form, which is NULL-unsafe.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized asset disposal for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Disposal metadata invariants. The values are derived server-side by the
  -- same planner that builds the draft entry, but the RPC is independently
  -- callable, so reject internally inconsistent register metadata here.
  IF coalesce(p_disposed_proceeds, 0) < 0 OR coalesce(p_proceeds_vat, 0) < 0 THEN
    RAISE EXCEPTION 'Disposal proceeds and VAT must be non-negative'
      USING ERRCODE = '23514';
  END IF;
  IF p_proceeds_vat > 0 AND p_vat_treatment IS NULL THEN
    RAISE EXCEPTION 'Disposal VAT requires a VAT treatment'
      USING ERRCODE = '23514';
  END IF;
  IF p_proceeds_vat > p_disposed_proceeds THEN
    RAISE EXCEPTION 'Disposal VAT cannot exceed gross proceeds'
      USING ERRCODE = '23514';
  END IF;
  IF p_disposal_type = 'scrap' AND coalesce(p_disposed_proceeds, 0) <> 0 THEN
    RAISE EXCEPTION 'Scrapping (utrangering) cannot carry proceeds'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT a.user_id
    INTO v_asset_user_id
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
     AND a.disposed_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found or already disposed: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT fp.period_start, fp.is_closed, fp.locked_at
    INTO v_period_start, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id
     AND p_disposed_at BETWEEN fp.period_start AND fp.period_end;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period does not contain disposal date'
      USING ERRCODE = '22007';
  END IF;

  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot dispose asset in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_company_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_company_lock_date IS NOT NULL AND p_disposed_at <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
      JOIN public.fiscal_periods fp ON fp.id = ds.fiscal_period_id
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
       AND fp.period_start > v_period_start
  ) THEN
    RAISE EXCEPTION 'Later depreciation is already posted for asset %', p_asset_id
      USING ERRCODE = '23514';
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT je.user_id
      INTO v_entry_user_id
      FROM public.journal_entries je
     WHERE je.id = p_entry_id
       AND je.company_id = p_company_id
       AND je.fiscal_period_id = p_fiscal_period_id
       AND je.entry_date = p_disposed_at
       AND je.status = 'draft'
       AND je.source_type = 'system'
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Valid disposal draft not found: %', p_entry_id
        USING ERRCODE = 'P0002';
    END IF;
  ELSIF abs(coalesce(p_current_depreciation, 0)) > 0.005 THEN
    RAISE EXCEPTION 'Current depreciation requires a disposal voucher'
      USING ERRCODE = '23514';
  END IF;

  IF coalesce(p_current_depreciation, 0) > 0.005 THEN
    SELECT ds.id, ds.journal_entry_id
      INTO v_schedule_id, v_schedule_entry_id
      FROM public.depreciation_schedules ds
     WHERE ds.asset_id = p_asset_id
       AND ds.fiscal_period_id = p_fiscal_period_id
     FOR UPDATE;

    IF FOUND AND v_schedule_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Depreciation was posted concurrently for asset %', p_asset_id
        USING ERRCODE = '23514';
    ELSIF FOUND THEN
      UPDATE public.depreciation_schedules
         SET planned_depreciation = p_current_depreciation,
             journal_entry_id = p_entry_id,
             posted_at = now()
       WHERE id = v_schedule_id;
    ELSE
      INSERT INTO public.depreciation_schedules (
        user_id,
        company_id,
        asset_id,
        fiscal_period_id,
        planned_depreciation,
        journal_entry_id,
        posted_at
      ) VALUES (
        coalesce(v_entry_user_id, v_asset_user_id),
        p_company_id,
        p_asset_id,
        p_fiscal_period_id,
        p_current_depreciation,
        p_entry_id,
        now()
      );
    END IF;
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT committed.voucher_number
      INTO v_voucher_number
      -- commit_method must be one of journal_entries_commit_method_check's
      -- allowed values; the disposal dialog is a user-accepted commit.
      FROM public.commit_journal_entry(
        p_company_id,
        p_entry_id,
        'user_accept',
        NULL,
        p_actor_type,
        p_actor_label
      ) AS committed;
  END IF;

  UPDATE public.assets
     SET disposed_at = p_disposed_at,
         disposed_proceeds = p_disposed_proceeds,
         disposed_proceeds_vat = p_proceeds_vat,
         disposed_vat_treatment = p_vat_treatment,
         disposal_type = p_disposal_type,
         disposal_journal_entry_id = p_entry_id,
         jamkning_amount = p_jamkning_amount,
         jamkning_direction = p_jamkning_direction,
         jamkning_remaining_years = p_jamkning_remaining_years,
         jamkning_total_years = p_jamkning_total_years,
         jamkning_original_input_vat = p_jamkning_original_input_vat,
         jamkning_original_deduction_percent = p_jamkning_original_deduction_percent,
         jamkning_new_deduction_percent = p_jamkning_new_deduction_percent,
         jamkning_remaining_months = NULL,
         jamkning_total_months = NULL
   WHERE id = p_asset_id
     AND company_id = p_company_id
     AND disposed_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset disposal lost concurrent update: %', p_asset_id
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT v_voucher_number;
END;
$function$
;

-- public.commit_journal_entry: last full definition in 20260921173226_guard_bank_booking_context, then patched by 20260922095736.
CREATE OR REPLACE FUNCTION public.commit_journal_entry(p_company_id uuid, p_entry_id uuid, p_commit_method text DEFAULT NULL::text, p_rubric_version text DEFAULT NULL::text, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS TABLE(voucher_number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  -- Use the same first lock as cash-account promotion, before the draft row.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version,
      committed_actor_type = p_actor_type,
      committed_actor_label = p_actor_label
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  RETURN QUERY SELECT v_next;
END;
$function$
;

-- public.commit_opening_balance_replacement: last full definition in 20260801222035_harden_atomic_opening_balance_replacement, then patched by 20260921180432.
CREATE OR REPLACE FUNCTION public.commit_opening_balance_replacement(p_company_id uuid, p_period_id uuid, p_expected_old_entry_id uuid, p_user_id uuid, p_entry_date date, p_description text, p_voucher_series text, p_lines jsonb, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS TABLE(new_entry_id uuid, storno_entry_id uuid, new_voucher_number integer, storno_voucher_number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claims jsonb := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_jwt_role text := COALESCE(
    NULLIF(v_claims ->> 'role', ''),
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    ''
  );
  v_member_role text;
  v_period public.fiscal_periods%ROWTYPE;
  v_old_entry public.journal_entries%ROWTYPE;
  v_lock_date date;
  v_new_entry_id uuid := uuid_generate_v4();
  v_storno_entry_id uuid := uuid_generate_v4();
  v_new_voucher_number integer;
  v_storno_voucher_number integer;
  v_line_count integer;
  v_updated_count integer;
  v_total_debit numeric;
  v_total_credit numeric;
BEGIN
  IF v_jwt_role = 'authenticated' THEN
    IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'unauthorized: user attribution does not match caller'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized: authenticated or service role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT cm.role
    INTO v_member_role
    FROM public.company_members cm
    JOIN public.companies company
      ON company.id = cm.company_id
     AND company.archived_at IS NULL
   WHERE cm.company_id = p_company_id
     AND cm.user_id = p_user_id;

  IF v_member_role IS NULL
     OR v_member_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'unauthorized: caller cannot write to company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT fp.*
    INTO v_period
    FROM public.fiscal_periods fp
   WHERE fp.id = p_period_id
     AND fp.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found: %', p_period_id;
  END IF;

  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot replace opening balance in locked/closed fiscal period "%"',
      v_period.name;
  END IF;

  IF v_period.opening_balances_set IS NOT TRUE
     OR v_period.opening_balance_entry_id IS DISTINCT FROM p_expected_old_entry_id THEN
    RAISE EXCEPTION 'Opening balance changed concurrently for fiscal period %', p_period_id
      USING ERRCODE = '40001';
  END IF;

  IF p_entry_date IS DISTINCT FROM v_period.period_start THEN
    RAISE EXCEPTION 'Replacement opening balance date must equal fiscal period start %',
      v_period.period_start;
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND p_entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_lock_date;
  END IF;

  SELECT je.*
    INTO v_old_entry
    FROM public.journal_entries je
   WHERE je.id = p_expected_old_entry_id
     AND je.company_id = p_company_id
     AND je.fiscal_period_id = p_period_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_old_entry.status <> 'posted'
     OR v_old_entry.source_type <> 'opening_balance' THEN
    RAISE EXCEPTION 'Expected opening balance is not a posted entry in period %', p_period_id;
  END IF;

  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Replacement opening balance requires at least one line';
  END IF;

  SELECT
    round(COALESCE(sum(line.debit_amount), 0), 2),
    round(COALESCE(sum(line.credit_amount), 0), 2)
  INTO v_total_debit, v_total_credit
  FROM jsonb_to_recordset(p_lines) AS line(
    account_number text,
    account_id uuid,
    debit_amount numeric,
    credit_amount numeric,
    currency text,
    amount_in_currency numeric,
    exchange_rate numeric,
    line_description text,
    tax_code text,
    dimensions jsonb,
    sort_order integer
  );

  IF v_total_debit <= 0 OR v_total_debit IS DISTINCT FROM v_total_credit THEN
    RAISE EXCEPTION 'Replacement opening balance is not balanced (debit %, credit %)',
      v_total_debit, v_total_credit;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_lines) AS line(
        account_number text,
        account_id uuid,
        debit_amount numeric,
        credit_amount numeric,
        currency text,
        amount_in_currency numeric,
        exchange_rate numeric,
        line_description text,
        tax_code text,
        dimensions jsonb,
        sort_order integer
      )
      LEFT JOIN public.chart_of_accounts account
        ON account.id = line.account_id
       AND account.company_id = p_company_id
       AND account.account_number = line.account_number
       AND account.is_active = true
     WHERE account.id IS NULL
        OR line.account_number IS NULL
        OR line.debit_amount IS NULL
        OR line.credit_amount IS NULL
        OR line.debit_amount < 0
        OR line.credit_amount < 0
        OR (line.debit_amount > 0 AND line.credit_amount > 0)
        OR (line.debit_amount = 0 AND line.credit_amount = 0)
  ) THEN
    RAISE EXCEPTION 'Replacement opening balance contains an invalid line';
  END IF;

  INSERT INTO public.journal_entries (
    id,
    user_id,
    company_id,
    fiscal_period_id,
    voucher_number,
    voucher_series,
    entry_date,
    description,
    source_type,
    status
  ) VALUES (
    v_new_entry_id,
    p_user_id,
    p_company_id,
    p_period_id,
    0,
    COALESCE(NULLIF(p_voucher_series, ''), 'A'),
    p_entry_date,
    p_description,
    'opening_balance',
    'draft'
  );

  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    account_number,
    account_id,
    debit_amount,
    credit_amount,
    currency,
    amount_in_currency,
    exchange_rate,
    line_description,
    tax_code,
    dimensions,
    sort_order
  )
  SELECT
    v_new_entry_id,
    line.account_number,
    line.account_id,
    round(line.debit_amount, 2),
    round(line.credit_amount, 2),
    COALESCE(NULLIF(line.currency, ''), 'SEK'),
    CASE
      WHEN line.amount_in_currency IS NULL THEN NULL
      ELSE round(line.amount_in_currency, 2)
    END,
    line.exchange_rate,
    line.line_description,
    line.tax_code,
    COALESCE(line.dimensions, '{}'::jsonb),
    COALESCE(line.sort_order, 0)
  FROM jsonb_to_recordset(p_lines) AS line(
    account_number text,
    account_id uuid,
    debit_amount numeric,
    credit_amount numeric,
    currency text,
    amount_in_currency numeric,
    exchange_rate numeric,
    line_description text,
    tax_code text,
    dimensions jsonb,
    sort_order integer
  );

  GET DIAGNOSTICS v_line_count = ROW_COUNT;
  IF v_line_count <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'Replacement opening balance line count changed during insert';
  END IF;

  INSERT INTO public.journal_entries (
    id,
    user_id,
    company_id,
    fiscal_period_id,
    voucher_number,
    voucher_series,
    entry_date,
    description,
    source_type,
    source_id,
    reverses_id,
    status
  ) VALUES (
    v_storno_entry_id,
    p_user_id,
    p_company_id,
    p_period_id,
    0,
    COALESCE(v_old_entry.voucher_series, 'A'),
    p_entry_date,
    'Makulering: ' || v_old_entry.description,
    'storno',
    v_old_entry.source_id,
    v_old_entry.id,
    'draft'
  );

  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    account_number,
    account_id,
    debit_amount,
    credit_amount,
    currency,
    amount_in_currency,
    exchange_rate,
    line_description,
    tax_code,
    dimensions,
    sort_order
  )
  SELECT
    v_storno_entry_id,
    line.account_number,
    line.account_id,
    line.credit_amount,
    line.debit_amount,
    line.currency,
    CASE
      WHEN line.amount_in_currency IS NULL OR line.amount_in_currency = 0 THEN NULL
      ELSE -line.amount_in_currency
    END,
    line.exchange_rate,
    'Reversal: ' || COALESCE(line.line_description, ''),
    line.tax_code,
    line.dimensions,
    line.sort_order
  FROM public.journal_entry_lines line
  WHERE line.journal_entry_id = v_old_entry.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected opening balance has no lines: %', v_old_entry.id;
  END IF;

  SELECT committed.voucher_number
    INTO v_new_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      v_new_entry_id,
      NULL,
      NULL,
      p_actor_type,
      p_actor_label
    ) committed;

  SELECT committed.voucher_number
    INTO v_storno_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      v_storno_entry_id,
      NULL,
      NULL,
      p_actor_type,
      p_actor_label
    ) committed;

  UPDATE public.journal_entries
     SET status = 'reversed',
         reversed_by_id = v_storno_entry_id
   WHERE id = v_old_entry.id
     AND company_id = p_company_id
     AND status = 'posted';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Opening balance changed concurrently: %', v_old_entry.id
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.fiscal_periods
     SET opening_balances_set = false
   WHERE id = p_period_id
     AND company_id = p_company_id
     AND opening_balance_entry_id = p_expected_old_entry_id
     AND opening_balances_set = true;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Opening balance pointer changed concurrently for fiscal period %', p_period_id
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.fiscal_periods
     SET opening_balance_entry_id = v_new_entry_id,
         opening_balances_set = true
   WHERE id = p_period_id
     AND company_id = p_company_id
     AND opening_balance_entry_id = p_expected_old_entry_id
     AND opening_balances_set = false;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Opening balance pointer could not be replaced for fiscal period %', p_period_id
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    v_new_entry_id,
    v_storno_entry_id,
    v_new_voucher_number,
    v_storno_voucher_number;
END;
$function$
;

-- public.correct_entry_lines_inline: last full definition in 20260831150000_inline_rattelse_opening_balance, then patched by 20260921181008, 20260922081830.
CREATE OR REPLACE FUNCTION public.correct_entry_lines_inline(p_company_id uuid, p_entry_id uuid, p_strike_line_ids uuid[], p_new_lines jsonb DEFAULT '[]'::jsonb, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role     text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor        uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role  text;
  v_entry        record;
  v_is_closed    boolean;
  v_locked_at    timestamptz;
  v_lock_date    date;
  v_strike_ids   uuid[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_strike_line_ids, '{}'::uuid[])));
  v_strike_count int := COALESCE(array_length(v_strike_ids, 1), 0);
  v_owned_count  int;
  v_line         jsonb;
  v_acc          text;
  v_debit        numeric;
  v_credit       numeric;
  v_new_count    int := 0;
  v_new_debit    numeric := 0;
  v_new_credit   numeric := 0;
  v_rem_debit    numeric;
  v_rem_credit   numeric;
  v_rem_count    int;
  v_struck_json  jsonb;
  v_struck_keys  text[];
  v_added_keys   text[];
  v_sort         int;
  v_added_ids    uuid[] := '{}';
  v_added_json   jsonb;
  v_new_id       uuid;
  v_log_id       uuid;
  v_fin_debit    numeric;
  v_fin_credit   numeric;
  v_fin_count    int;
  v_bank_linked     boolean;
  v_bank_origin_unlinked boolean;
  v_invoice_linked  boolean;
  v_supplier_linked boolean;
  v_delta        numeric;
  v_anchor       numeric;
  v_post_net     numeric;
  v_is_ob        boolean := false;
  v_linked_ob    uuid;
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
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan rätta verifikat.';
  END IF;

  IF p_new_lines IS NULL OR jsonb_typeof(p_new_lines) <> 'array' THEN
    RAISE EXCEPTION 'Nya rader måste vara en lista.';
  END IF;

  IF v_strike_count = 0 AND jsonb_array_length(p_new_lines) = 0 THEN
    RAISE EXCEPTION 'Rättelsen måste stryka eller lägga till minst en rad.';
  END IF;

  IF jsonb_array_length(p_new_lines) > 100 THEN
    RAISE EXCEPTION 'Högst 100 nya rader per rättelse.';
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT je.id, je.status, je.entry_date, je.source_type,
         je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     FOR UPDATE OF je;

  IF NOT FOUND OR v_entry.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationen hittades inte.';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Endast bokförda verifikat kan rättas (utkast redigeras direkt).';
  END IF;

  -- Structural entry types keep their dedicated flows: a storno mirrors its
  -- original, year-end vouchers feed dispositions/idempotency checks. An IB
  -- (source_type 'opening_balance') IS allowed since 20260831150000: the
  -- entry id (and thus fiscal_periods.opening_balance_entry_id) never
  -- changes, and the IB-specific guards below apply.
  IF v_entry.source_type IN ('storno', 'year_end', 'vat_settlement') THEN
    RAISE EXCEPTION 'Den här verifikationstypen kan inte rättas radvis: använd dess egen rättelsefunktion.';
  END IF;

  v_is_ob := v_entry.source_type = 'opening_balance';

  SELECT fp.is_closed, fp.locked_at, fp.opening_balance_entry_id
    INTO v_is_closed, v_locked_at, v_linked_ob
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst: använd rättelseverifikat (storno).';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_entry.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. %: använd rättelseverifikat (storno).', v_lock_date;
  END IF;

  IF v_is_ob THEN
    -- Guard 1: only the period's CURRENT linked IB is a rättelse target.
    IF v_linked_ob IS DISTINCT FROM p_entry_id THEN
      RAISE EXCEPTION 'Verifikationen är inte periodens aktuella ingående balans.';
    END IF;

    -- Guard 2: a posted bokslut on the period must be unwound first, same
    -- rule as the storno-based IB correction flow.
    IF EXISTS (
      SELECT 1 FROM public.journal_entries je2
       WHERE je2.company_id = p_company_id
         AND je2.fiscal_period_id = v_entry.fiscal_period_id
         AND je2.source_type = 'year_end'
         AND je2.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'Perioden har ett bokslut. Återför bokslutet innan ingående balanser kan rättas.';
    END IF;
  END IF;

  -- Every struck id must be a line of THIS entry.
  SELECT count(*) INTO v_owned_count
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id
     AND jel.id = ANY (v_strike_ids);

  IF v_owned_count <> v_strike_count THEN
    RAISE EXCEPTION 'En eller flera rader som ska strykas hör inte till verifikationen.';
  END IF;

  -- Foreign-currency lines carry conversion data (amount_in_currency /
  -- exchange_rate) that replacement lines cannot reproduce: those
  -- corrections stay on the storno flow.
  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id = p_entry_id
       AND jel.id = ANY (v_strike_ids)
       AND jel.currency IS NOT NULL AND jel.currency <> 'SEK'
  ) THEN
    RAISE EXCEPTION 'Rader i utländsk valuta kan inte strykas: använd rättelseverifikat (storno).';
  END IF;

  -- A struck line with a line-level underlag link would sever the document
  -- coupling (document_attachments.journal_entry_line_id is ON DELETE
  -- RESTRICT, so the DELETE would fail anyway: this gives a clear message).
  IF EXISTS (
    SELECT 1 FROM public.document_attachments da
     WHERE da.journal_entry_line_id = ANY (v_strike_ids)
  ) THEN
    RAISE EXCEPTION 'En rad som ska strykas har ett kopplat underlag: använd rättelseverifikat (storno).';
  END IF;

  -- Validate the replacement lines. SEK only: inline additions never carry
  -- foreign-currency conversion data (that correction stays on the storno flow).
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_lines)
  LOOP
    v_acc    := btrim(COALESCE(v_line ->> 'account_number', ''));
    v_debit  := round(COALESCE((v_line ->> 'debit_amount')::numeric, 0), 2);
    v_credit := round(COALESCE((v_line ->> 'credit_amount')::numeric, 0), 2);

    IF v_acc !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'Ogiltigt kontonummer: "%".', v_acc;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts coa
       WHERE coa.company_id = p_company_id AND coa.account_number = v_acc
    ) THEN
      RAISE EXCEPTION 'Kontot % finns inte i kontoplanen.', v_acc;
    END IF;
    -- Guard 3 (IB only): opening balances hold balance-sheet accounts
    -- (class 1-2). P&L balances reset at year start (BFNAR 2013:2).
    IF v_is_ob AND left(v_acc, 1) NOT IN ('1', '2') THEN
      RAISE EXCEPTION 'Resultatkonton (klass 3-8) kan inte användas i ingående balanser (konto %).', v_acc;
    END IF;
    IF v_debit < 0 OR v_credit < 0 THEN
      RAISE EXCEPTION 'Belopp kan inte vara negativa (konto %).', v_acc;
    END IF;
    IF v_debit > 0 AND v_credit > 0 THEN
      RAISE EXCEPTION 'En rad kan inte ha både debet och kredit (konto %).', v_acc;
    END IF;
    IF v_debit = 0 AND v_credit = 0 THEN
      RAISE EXCEPTION 'En rad måste ha ett belopp (konto %).', v_acc;
    END IF;

    v_new_count  := v_new_count + 1;
    v_new_debit  := v_new_debit + v_debit;
    v_new_credit := v_new_credit + v_credit;
  END LOOP;

  -- Effective post-state must balance and stay a real bokföringspost.
  SELECT COALESCE(sum(jel.debit_amount), 0), COALESCE(sum(jel.credit_amount), 0), count(*)
    INTO v_rem_debit, v_rem_credit, v_rem_count
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id
     AND NOT (jel.id = ANY (v_strike_ids));

  IF (v_rem_count + v_new_count) < 2 THEN
    RAISE EXCEPTION 'Verifikationen måste ha minst två rader efter rättelsen. Använd "Återför (storno)" för att makulera hela verifikationen.';
  END IF;

  IF abs((v_rem_debit + v_new_debit) - (v_rem_credit + v_new_credit)) >= 0.005 THEN
    RAISE EXCEPTION 'Verifikationen balanserar inte efter rättelsen (debet %, kredit %).',
      round(v_rem_debit + v_new_debit, 2), round(v_rem_credit + v_new_credit, 2);
  END IF;

  IF (v_rem_debit + v_new_debit) < 0.005 THEN
    RAISE EXCEPTION 'Rättelsen skulle nollställa verifikationen. Använd "Återför (storno)" i stället.';
  END IF;

  -- A rättelse must change something: striking rows and re-adding an
  -- identical set is a no-op in disguise. The key includes dimensions (as
  -- canonical jsonb text) so a dimensions-only rättelse counts as a change
  -- (CodeRabbit finding on PR #2076; the 20260819 version omitted it).
  SELECT COALESCE(array_agg(k ORDER BY k), '{}'), COALESCE(jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order), '[]'::jsonb)
    INTO v_struck_keys, v_struck_json
    FROM public.journal_entry_lines jel,
         LATERAL (SELECT jel.account_number || '|' || round(jel.debit_amount, 2)::text || '|'
                         || round(jel.credit_amount, 2)::text || '|' || COALESCE(jel.line_description, '') || '|'
                         || COALESCE(jel.dimensions, '{}'::jsonb)::text) AS key(k)
   WHERE jel.journal_entry_id = p_entry_id
     AND jel.id = ANY (v_strike_ids);

  SELECT COALESCE(array_agg(k ORDER BY k), '{}')
    INTO v_added_keys
    FROM (
      SELECT btrim(l ->> 'account_number') || '|'
             || round(COALESCE((l ->> 'debit_amount')::numeric, 0), 2)::text || '|'
             || round(COALESCE((l ->> 'credit_amount')::numeric, 0), 2)::text || '|'
             || COALESCE(NULLIF(btrim(COALESCE(l ->> 'line_description', '')), ''), '') || '|'
             || COALESCE(l -> 'dimensions', '{}'::jsonb)::text AS k
        FROM jsonb_array_elements(p_new_lines) AS l
    ) keys;

  IF v_struck_keys = v_added_keys THEN
    RAISE EXCEPTION 'Rättelsen ändrar ingenting.';
  END IF;

  -- Reconciliation guard: when the entry is anchored to external records
  -- (bank transactions, payment links), the anchored side must agree with
  -- the external amount. The bank feed / payment amount is immutable, so a
  -- strike that moves the 19xx/cash-account (or reskontra) net AWAY from it
  -- would create a permanent unexplained reconciliation difference.
  --
  -- On the bank side two shapes are allowed:
  --   1. net-preserving strikes (e.g. fixing a line description);
  --   2. strikes whose post-state net on the account EQUALS the linked bank
  --      amount. This is the "wrong contra line on the bank account itself"
  --      case (1930 D / 1930 K against a deposit): the entry never matched
  --      the feed, and the rättelse is exactly what makes it match again.
  -- Anything else still needs a rättelseverifikat (storno). Reskontra sides
  -- (15xx for customer payments, 24xx for supplier payments) stay strictly
  -- net-preserving: their anchor is the payment row, not a bank amount.

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
                OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.journal_entry_id = p_entry_id)
                OR EXISTS (SELECT 1 FROM public.transaction_voucher_links tvl WHERE tvl.journal_entry_id = p_entry_id);
  v_invoice_linked := EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.journal_entry_id = p_entry_id);
  v_supplier_linked := EXISTS (SELECT 1 FROM public.supplier_invoice_payments sp WHERE sp.journal_entry_id = p_entry_id);

  IF v_bank_linked OR v_invoice_linked OR v_supplier_linked THEN
    FOR v_acc, v_delta IN
      SELECT x.acc, sum(x.delta)
        FROM (
          SELECT jel.account_number AS acc,
                 -(jel.debit_amount - jel.credit_amount) AS delta
            FROM public.journal_entry_lines jel
           WHERE jel.journal_entry_id = p_entry_id
             AND jel.id = ANY (v_strike_ids)
          UNION ALL
          SELECT btrim(l ->> 'account_number'),
                 round(COALESCE((l ->> 'debit_amount')::numeric, 0), 2)
                 - round(COALESCE((l ->> 'credit_amount')::numeric, 0), 2)
            FROM jsonb_array_elements(p_new_lines) AS l
        ) x
       GROUP BY x.acc
    LOOP
      IF abs(v_delta) < 0.005 THEN
        CONTINUE;
      END IF;

      IF v_bank_linked AND (v_acc LIKE '19%' OR v_acc IN (
           SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.company_id = p_company_id)) THEN
        IF v_bank_origin_unlinked THEN
          RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
        END IF;
        -- Signed bank amount anchored on this account across every linked
        -- transaction, counted once per transaction: a split link
        -- (transaction_voucher_links, bank_line role) carries the allocated
        -- slice, otherwise the transaction's own amount (the 1:1 path sets
        -- both the direct FK and a link row for the same transaction).
        -- Positive = deposit = debit on the bank account, so it compares to
        -- the post-state net debit - credit. A transaction without a
        -- cash_account_id resolves to the company's primary cash account,
        -- falling back to 1930 (the historical default ledger).
        SELECT sum(x.amount) INTO v_anchor
          FROM (
            SELECT COALESCE(
                     (SELECT sum(tvl.allocated_amount)
                        FROM public.transaction_voucher_links tvl
                       WHERE tvl.transaction_id = t.id
                         AND tvl.journal_entry_id = p_entry_id
                         AND tvl.role = 'bank_line'),
                     t.amount) AS amount
              FROM public.transactions t
             WHERE t.company_id = p_company_id
               AND (t.journal_entry_id = p_entry_id
                    OR EXISTS (SELECT 1 FROM public.transaction_voucher_links tvl
                                WHERE tvl.transaction_id = t.id
                                  AND tvl.journal_entry_id = p_entry_id
                                  AND tvl.role = 'bank_line'))
               AND COALESCE(
                     (SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.id = t.cash_account_id),
                     (SELECT ca.ledger_account FROM public.cash_accounts ca
                       WHERE ca.company_id = p_company_id AND ca.is_primary
                       ORDER BY ca.created_at LIMIT 1),
                     '1930') = v_acc
          ) x;

        SELECT COALESCE(sum(jel.debit_amount - jel.credit_amount), 0) INTO v_post_net
          FROM public.journal_entry_lines jel
         WHERE jel.journal_entry_id = p_entry_id
           AND jel.account_number = v_acc
           AND NOT (jel.id = ANY (v_strike_ids));
        v_post_net := v_post_net + COALESCE((
          SELECT sum(round(COALESCE((l ->> 'debit_amount')::numeric, 0), 2)
                     - round(COALESCE((l ->> 'credit_amount')::numeric, 0), 2))
            FROM jsonb_array_elements(p_new_lines) AS l
           WHERE btrim(l ->> 'account_number') = v_acc), 0);

        IF v_anchor IS NULL THEN
          RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
        END IF;
        IF abs(v_post_net - v_anchor) >= 0.005 THEN
          RAISE EXCEPTION 'Raden mot konto % kan inte ändras så: verifikationen är kopplad till en banktransaktion på % kr, och kontots belopp efter rättelsen skulle bli % kr. Rättelsen måste få bankkontot att stämma med banken, annars: använd rättelseverifikat (storno).',
            v_acc, round(v_anchor, 2), round(v_post_net, 2);
        END IF;
      ELSIF (v_invoice_linked AND v_acc LIKE '15%')
         OR (v_supplier_linked AND v_acc LIKE '24%') THEN
        RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('gnubok.allow_line_rattelse', 'true', true);

  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id = p_entry_id
     AND id = ANY (v_strike_ids);

  SELECT COALESCE(max(jel.sort_order), 0) INTO v_sort
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_lines)
  LOOP
    v_sort := v_sort + 1;
    -- cost_center/project are GENERATED columns derived from dimensions:
    -- never inserted explicitly, they recompute from the bag.
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, account_id, debit_amount, credit_amount,
       line_description, sort_order, dimensions, currency)
    VALUES
      (p_entry_id,
       btrim(v_line ->> 'account_number'),
       (SELECT coa.id FROM public.chart_of_accounts coa
         WHERE coa.company_id = p_company_id
           AND coa.account_number = btrim(v_line ->> 'account_number')
         ORDER BY (coa.is_active IS TRUE) DESC, coa.created_at
         LIMIT 1),
       round(COALESCE((v_line ->> 'debit_amount')::numeric, 0), 2),
       round(COALESCE((v_line ->> 'credit_amount')::numeric, 0), 2),
       NULLIF(btrim(COALESCE(v_line ->> 'line_description', '')), ''),
       v_sort,
       COALESCE(v_line -> 'dimensions', '{}'::jsonb),
       'SEK')
    RETURNING id INTO v_new_id;
    v_added_ids := v_added_ids || v_new_id;
  END LOOP;

  PERFORM set_config('gnubok.allow_line_rattelse', 'false', true);

  -- Authoritative post-state verification straight from the table: the entry
  -- must still balance to the öre and hold at least two lines, or everything
  -- rolls back.
  SELECT COALESCE(sum(jel.debit_amount), 0), COALESCE(sum(jel.credit_amount), 0), count(*)
    INTO v_fin_debit, v_fin_credit, v_fin_count
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id;

  IF abs(v_fin_debit - v_fin_credit) >= 0.005 OR v_fin_count < 2 OR v_fin_debit < 0.005 THEN
    RAISE EXCEPTION 'Internt fel: verifikationen balanserar inte efter rättelsen: ändringen har återställts.';
  END IF;

  -- Close the check-then-write window on period locks: if a lock or close
  -- committed while this rättelse was running, abort and roll back rather
  -- than write into a period that is now locked.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;
  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst: använd rättelseverifikat (storno).';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order), '[]'::jsonb)
    INTO v_added_json
    FROM public.journal_entry_lines jel
   WHERE jel.id = ANY (v_added_ids);

  INSERT INTO public.journal_entry_rattelse_log
    (company_id, journal_entry_id, rattelse_type, struck_lines, added_lines, actor)
  VALUES
    (p_company_id, p_entry_id, 'lines', v_struck_json, v_added_json, v_actor)
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'log_id', v_log_id,
    'struck_count', v_strike_count,
    'added_count', v_new_count,
    'total_debit', round(v_fin_debit, 2),
    'total_credit', round(v_fin_credit, 2)
  );
END;
$function$
;

-- public.create_expense_payout_batch: last full definition in 20260906210300_utlagg_via_lon, then patched by 20260921180432.
CREATE OR REPLACE FUNCTION public.create_expense_payout_batch(p_company_id uuid, p_claim_ids uuid[], p_payout_date date, p_cash_account text, p_notes text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_transaction_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_ids uuid[];
  v_claim record;
  v_count integer := 0;
  v_first boolean := true;
  v_employee_id uuid;
  v_claimant_name text;
  v_claimant_key text;
  v_liability text;
  v_total numeric(15,2) := 0;
  v_period_id uuid;
  v_period_locked_at timestamptz;
  v_series text := 'A';
  v_series_raw text;
  v_batch_id uuid := gen_random_uuid();
  v_je_id uuid := gen_random_uuid();
  v_voucher_number integer;
  v_desc text;
  v_marked integer;
  v_tx record;
  v_tx_updated integer;
  v_debit text;
  v_payslip record;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  -- Same gate as the expense tables' write policies (owner/admin/member);
  -- SECURITY DEFINER bypasses RLS, so the check has to be explicit.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = v_caller
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  SELECT ARRAY(SELECT DISTINCT unnest(p_claim_ids)) INTO v_ids;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CLAIMS');
  END IF;
  IF p_cash_account IS NULL OR p_cash_account !~ '^19[0-9]{2}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_CASH_ACCOUNT');
  END IF;

  PERFORM public.lock_cash_account_booking_state(p_company_id);

  -- Lock the claims. A concurrent caller for any of the same rows queues on
  -- this lock and, once this transaction commits, reads them as 'paid'.
  FOR v_claim IN
    SELECT ec.id, ec.status, ec.employee_id, ec.claimant_name, ec.liability_account, ec.amount_sek
    FROM public.expense_claims ec
    WHERE ec.id = ANY(v_ids)
      AND ec.company_id = p_company_id
    ORDER BY ec.id
    FOR UPDATE
  LOOP
    v_count := v_count + 1;
    IF v_claim.status <> 'registered' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_PAID',
        'details', jsonb_build_object('claim_id', v_claim.id));
    END IF;
    -- A claim on a payslip line is repaid by that salary run (#2331): a bank
    -- transfer on top would pay the person twice. Remove the line from the
    -- draft payslip first if the bank path is the intended one.
    SELECT sr.id AS salary_run_id, sr.period_year, sr.period_month, sr.status
      INTO v_payslip
    FROM public.salary_line_items sli
    JOIN public.salary_run_employees sre ON sre.id = sli.salary_run_employee_id
    JOIN public.salary_runs sr ON sr.id = sre.salary_run_id
    WHERE sli.source_expense_claim_id = v_claim.id
      AND sli.company_id = p_company_id
    LIMIT 1;
    IF v_payslip.salary_run_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ON_PAYSLIP',
        'details', jsonb_build_object(
          'claim_id', v_claim.id,
          'salary_run_id', v_payslip.salary_run_id,
          'salary_run_status', v_payslip.status,
          'period', v_payslip.period_year::text || '-' || lpad(v_payslip.period_month::text, 2, '0')));
    END IF;
    IF v_first THEN
      v_employee_id := v_claim.employee_id;
      v_claimant_name := v_claim.claimant_name;
      v_claimant_key := COALESCE(v_claim.employee_id::text, 'name:' || lower(btrim(v_claim.claimant_name)));
      v_liability := v_claim.liability_account;
      v_first := false;
    ELSE
      IF COALESCE(v_claim.employee_id::text, 'name:' || lower(btrim(v_claim.claimant_name))) <> v_claimant_key THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MIXED_CLAIMANTS');
      END IF;
      IF v_claim.liability_account <> v_liability THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MIXED_LIABILITY');
      END IF;
    END IF;
    v_total := v_total + v_claim.amount_sek;
  END LOOP;

  IF v_count <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLAIMS_NOT_FOUND');
  END IF;

  -- Bank-line mode: the transfer that repays these claims. Locked with the
  -- claims so a concurrent categorisation of the same row waits and then
  -- sees it booked. The amount must equal the claims exactly (öre): a partial
  -- transfer is a different payout, chosen by a different set of claims.
  IF p_transaction_id IS NOT NULL THEN
    SELECT t.id, t.amount, t.currency, t.date
      INTO v_tx
    FROM public.transactions t
    WHERE t.id = p_transaction_id
      AND t.company_id = p_company_id
    FOR UPDATE;
    IF v_tx.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_NOT_FOUND');
    END IF;
    IF public.is_transaction_booked(v_tx.id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_ALREADY_BOOKED');
    END IF;
    IF upper(COALESCE(v_tx.currency, 'SEK')) <> 'SEK' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_CURRENCY',
        'details', jsonb_build_object('currency', v_tx.currency));
    END IF;
    IF v_tx.amount >= 0 OR round(-v_tx.amount, 2) <> v_total THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_AMOUNT_MISMATCH',
        'details', jsonb_build_object('transaction_amount', v_tx.amount, 'claims_total', v_total));
    END IF;
  END IF;

  -- Open fiscal year covering the payout date (mirrors engine.findFiscalPeriod).
  SELECT fp.id, fp.locked_at
    INTO v_period_id, v_period_locked_at
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.period_start <= p_payout_date
    AND fp.period_end >= p_payout_date
    AND fp.is_closed = false
  ORDER BY fp.period_start DESC
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_PERIOD_NOT_FOUND');
  END IF;
  IF v_period_locked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PERIOD_LOCKED',
      'details', jsonb_build_object('fiscal_period_id', v_period_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a
    WHERE a.company_id = p_company_id
      AND a.account_number = p_cash_account
      AND COALESCE(a.is_active, true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_IN_CHART',
      'details', jsonb_build_object('account', p_cash_account));
  END IF;
  v_debit := CASE WHEN v_liability = '2018' THEN '2013' ELSE v_liability END;
  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a
    WHERE a.company_id = p_company_id
      AND a.account_number = v_debit
      AND COALESCE(a.is_active, true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_IN_CHART',
      'details', jsonb_build_object('account', v_debit));
  END IF;

  -- Voucher series: the per-source-type default from company_settings, 'A'
  -- otherwise (mirrors resolveDefaultSeriesForSource).
  SELECT cs.default_voucher_series_per_source_type ->> 'expense_payout'
    INTO v_series_raw
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  IF v_series_raw ~ '^[A-Z]$' THEN
    v_series := v_series_raw;
  END IF;

  v_desc := 'Utbetalning utlägg: ' || v_claimant_name || ' (' || v_count || ' st)';

  INSERT INTO public.expense_payout_batches
    (id, company_id, user_id, employee_id, claimant_name, payout_date,
     cash_account, liability_account, total_sek, notes)
  VALUES
    (v_batch_id, p_company_id, v_caller, v_employee_id, v_claimant_name, p_payout_date,
     p_cash_account, v_liability, v_total, p_notes);

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, source_id, status, bank_booking_context)
  VALUES
    (v_je_id, v_caller, p_company_id, v_period_id, 0, v_series,
     p_payout_date, v_desc, 'expense_payout', v_batch_id, 'draft',
     CASE WHEN p_transaction_id IS NULL THEN '[]'::jsonb
       ELSE public.capture_bank_booking_context(p_company_id, ARRAY[p_transaction_id]) END);

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
  VALUES
    (v_je_id, v_debit, v_total, 0, 'SEK', 0, v_desc),
    (v_je_id, p_cash_account, 0, v_total, 'SEK', 1, v_desc);

  SELECT voucher_number INTO v_voucher_number
  FROM public.commit_journal_entry(p_company_id, v_je_id);

  UPDATE public.expense_payout_batches
  SET journal_entry_id = v_je_id
  WHERE id = v_batch_id AND company_id = p_company_id;

  UPDATE public.expense_claims
  SET status = 'paid', payout_batch_id = v_batch_id
  WHERE id = ANY(v_ids)
    AND company_id = p_company_id
    AND status = 'registered';
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  IF v_marked <> cardinality(v_ids) THEN
    -- Cannot happen while the rows are locked above; if it ever does, the
    -- exception rolls back the batch and the verifikat together.
    RAISE EXCEPTION 'create_expense_payout_batch: marked % of % claims paid', v_marked, cardinality(v_ids);
  END IF;

  IF p_transaction_id IS NOT NULL THEN
    -- Same stamp as the bulk-book RPCs: the 1:1 pointer plus is_business, so
    -- every "unbooked" predicate (inbox, worklist, badges) drops the row.
    UPDATE public.transactions
    SET journal_entry_id = v_je_id,
        is_business = TRUE,
        reconciliation_method = 'manual',
        updated_at = now()
    WHERE id = p_transaction_id
      AND company_id = p_company_id
      AND journal_entry_id IS NULL;
    GET DIAGNOSTICS v_tx_updated = ROW_COUNT;
    IF v_tx_updated <> 1 THEN
      RAISE EXCEPTION 'create_expense_payout_batch: transaction % could not be linked', p_transaction_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', v_batch_id,
    'journal_entry_id', v_je_id,
    'voucher_number', v_voucher_number,
    'total_sek', v_total,
    'claim_count', cardinality(v_ids),
    'transaction_id', p_transaction_id
  );
END;
$function$
;

-- public.ensure_company_dimensions: last full definition in 20260702084500_dimensions_substrate, then patched by 20260703180000.
CREATE OR REPLACE FUNCTION public.ensure_company_dimensions(p_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Tenant guard: authenticated callers must be members of the company.
  -- Service-role callers (auth.uid() IS NULL) are trusted — server code scopes
  -- by company_id (defense-in-depth pattern used across the codebase).
  IF auth.uid() IS NOT NULL
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'not a member of company %', p_company_id;
  END IF;

  INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, sort_order)
  VALUES
    (p_company_id, 1, 'Kostnadsställe', true,  true, 10),
    (p_company_id, 6, 'Projekt',        false, true, 20)
  ON CONFLICT (company_id, sie_dim_no) DO NOTHING;
END;
$function$
;

-- public.guard_bank_booking_context: last full definition in 20260921173226_guard_bank_booking_context, then patched by 20260921174642, 20260921180820, 20260921183218, 20260922102109.
CREATE OR REPLACE FUNCTION public.guard_bank_booking_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_context jsonb;
  v_transaction public.transactions%ROWTYPE;
  v_cash public.cash_accounts%ROWTYPE;
  v_target public.cash_accounts%ROWTYPE;
  v_ledger text;
  v_count integer;
  v_target_id uuid;
  v_own_released boolean;
  v_target_live boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed')
     AND NEW.bank_booking_context IS DISTINCT FROM OLD.bank_booking_context THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'posted' OR (TG_OP = 'UPDATE' AND OLD.status = 'posted') THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
       AND OLD.status IN ('posted', 'reversed') THEN
      PERFORM public.observe_cash_account_company(NEW.company_id);
    END IF;
    RETURN NEW;
  END IF;

  -- All posting participates in keeper-history serialization, including
  -- manual/import entries that do not originate from a bank transaction.
  PERFORM public.observe_cash_account_company(NEW.company_id);
  IF NEW.source_type = 'bank_transaction' AND (NEW.source_id IS NULL OR NOT (
    NEW.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', NEW.source_id))
  )) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  PERFORM public.validate_journal_bank_anchors(NEW.company_id, NEW.id);
  IF jsonb_array_length(NEW.bank_booking_context) = 0 THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.bank_booking_context) c
    WHERE jsonb_typeof(c) <> 'object'
       OR NOT (c ?& ARRAY['transaction_id','cash_account_id','settlement_account','date','amount','currency'])
       OR jsonb_typeof(c->'transaction_id') <> 'string'
       OR jsonb_typeof(c->'cash_account_id') NOT IN ('string','null')
       OR jsonb_typeof(c->'settlement_account') <> 'string'
       OR jsonb_typeof(c->'date') <> 'string'
       OR jsonb_typeof(c->'amount') <> 'number'
       OR jsonb_typeof(c->'currency') <> 'string'
       OR (c ? 'target_cash_account_id' AND jsonb_typeof(c->'target_cash_account_id') <> 'string')
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.bank_booking_context) c
    GROUP BY c->>'transaction_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- Same order as ingest and promotion. The company lock also serializes
  -- account creation/configuration once those writers use this protocol.
  PERFORM 1 FROM public.bank_connections WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.transactions t WHERE t.company_id = NEW.company_id
    AND t.id IN (SELECT (c->>'transaction_id')::uuid FROM jsonb_array_elements(NEW.bank_booking_context) c)
    ORDER BY t.id FOR UPDATE NOWAIT;

  FOR v_context IN SELECT c FROM jsonb_array_elements(NEW.bank_booking_context) c ORDER BY c->>'transaction_id' LOOP
    SELECT * INTO v_transaction FROM public.transactions
      WHERE company_id = NEW.company_id AND id = (v_context->>'transaction_id')::uuid;
    IF NOT FOUND OR v_transaction.cash_account_id IS DISTINCT FROM (v_context->>'cash_account_id')::uuid
      OR v_transaction.date IS DISTINCT FROM (v_context->>'date')::date
      OR v_transaction.amount IS DISTINCT FROM (v_context->>'amount')::numeric
      OR COALESCE(v_transaction.currency, 'SEK') IS DISTINCT FROM v_context->>'currency' THEN
      RAISE EXCEPTION 'BANK_BOOKING_SOURCE_CHANGED' USING ERRCODE = 'PT409';
    END IF;

    v_target_id := (v_context->>'target_cash_account_id')::uuid;
    IF v_target_id IS NOT NULL AND v_target_id IS DISTINCT FROM v_transaction.cash_account_id THEN
      SELECT * INTO v_cash FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id;
      SELECT * INTO v_target FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_target_id;
      IF v_cash.id IS NULL OR v_target.id IS NULL OR NOT v_target.enabled
        OR nullif(regexp_replace(upper(v_cash.iban), '\s', '', 'g'), '') IS NULL
        OR regexp_replace(upper(v_cash.iban), '\s', '', 'g') IS DISTINCT FROM regexp_replace(upper(v_target.iban), '\s', '', 'g')
        OR v_cash.currency IS DISTINCT FROM v_target.currency
        OR v_target.currency IS DISTINCT FROM COALESCE(v_transaction.currency, 'SEK')
        OR NOT public.cash_transaction_is_movable(NEW.company_id, v_transaction.id) THEN
        RAISE EXCEPTION 'BANK_BOOKING_REBIND_REFUSED' USING ERRCODE = '23514';
      END IF;
      -- Match shouldRepointToSibling: live destination, or released source
      -- with no live sibling. Same-currency, enabled physical siblings only.
      v_target_live := EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.id = v_target.bank_connection_id AND b.company_id = NEW.company_id AND b.status = 'active');
      v_own_released := v_cash.bank_connection_id IS NULL OR EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.id = v_cash.bank_connection_id AND b.company_id = NEW.company_id AND b.status = 'revoked');
      IF NOT v_target_live AND (NOT v_own_released OR EXISTS (
        SELECT 1 FROM public.cash_accounts c JOIN public.bank_connections b ON b.id = c.bank_connection_id AND b.company_id = c.company_id
        WHERE c.company_id = NEW.company_id AND c.id <> v_cash.id AND c.enabled AND b.status = 'active'
          AND c.currency = v_cash.currency
          AND regexp_replace(upper(c.iban), '\s', '', 'g') = regexp_replace(upper(v_cash.iban), '\s', '', 'g')
      )) THEN
        RAISE EXCEPTION 'BANK_BOOKING_REBIND_REFUSED' USING ERRCODE = '23514';
      END IF;
      UPDATE public.transactions SET cash_account_id = v_target_id WHERE company_id = NEW.company_id AND id = v_transaction.id;
      v_transaction.cash_account_id := v_target_id;
    END IF;

    IF v_transaction.cash_account_id IS NOT NULL THEN
      SELECT ledger_account INTO v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF NOT FOUND THEN RAISE EXCEPTION 'BANK_BOOKING_CASH_ACCOUNT_MISSING' USING ERRCODE = '23514'; END IF;
    ELSE
      -- Match resolveSettlementAccount's existing unbound-row fallback.
      SELECT count(*), min(ledger_account) INTO v_count, v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND enabled AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF v_count <> 1 THEN v_ledger := '1930'; END IF;
    END IF;
    IF v_ledger IS DISTINCT FROM v_context->>'settlement_account' OR NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id = NEW.id AND l.account_number = v_ledger
        AND ((v_transaction.amount < 0 AND l.credit_amount > 0) OR (v_transaction.amount > 0 AND l.debit_amount > 0))
    ) THEN
      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$
;

-- public.guard_bank_configuration_writer: last full definition in 20260921191040_save_bank_account_selection_atomically, then patched by 20260922100345, 20260922100455.
CREATE OR REPLACE FUNCTION public.guard_bank_configuration_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'bank_connections' THEN
    IF coalesce(has_function_privilege(current_user, to_regprocedure('public.erase_user_personal_data(uuid)')::oid, 'EXECUTE'), false)
       AND NEW.status = 'revoked'
       AND NEW.session_id IS NULL
       AND NEW.authorization_id IS NULL
       AND NEW.oauth_state IS NULL
       AND NEW.accounts_data IS NULL
       AND (to_jsonb(NEW) - ARRAY['status','session_id','authorization_id','oauth_state','accounts_data','updated_at'])
         = (to_jsonb(OLD) - ARRAY['status','session_id','authorization_id','oauth_state','accounts_data','updated_at']) THEN
      -- The protected caller already authorized erasure. Keep the same
      -- company coordination, including after membership removal and for an
      -- archived company, but never wait while holding a connection row.
      BEGIN
        PERFORM 1 FROM public.companies WHERE id = NEW.company_id FOR NO KEY UPDATE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
      END;
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'cash_accounts' THEN
      IF to_jsonb(NEW) - ARRAY['balance','available_balance','balance_updated_at','updated_at']
        = to_jsonb(OLD) - ARRAY['balance','available_balance','balance_updated_at','updated_at'] THEN RETURN NEW; END IF;
    ELSIF public.bank_connection_configuration_state(to_jsonb(NEW))
      = public.bank_connection_configuration_state(to_jsonb(OLD)) THEN RETURN NEW;
    END IF;
  END IF;
  FOR v_company IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.company_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.company_id END
  ]) id WHERE id IS NOT NULL ORDER BY id LOOP
    -- Parent deletion already holds this company's row lock. Its FK cascade
    -- runs after the parent row is gone and cannot create a new bank claim.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.companies WHERE id = v_company) THEN CONTINUE; END IF;
    PERFORM public.lock_cash_account_company(v_company, false);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
;

-- public.guard_cash_transaction_binding: last full definition in 20260921183218_guard_cash_transaction_anchors, then patched by 20260921184538, 20260922102109.
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
       AND NOT EXISTS (SELECT 1 FROM public.journal_entries j
         WHERE j.company_id = OLD.company_id AND j.status = 'posted'
           AND ((j.source_type = 'bank_transaction' AND j.source_id = OLD.id)
             OR j.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', OLD.id))))
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
      UNION SELECT j.id FROM public.journal_entries j
        WHERE j.company_id = NEW.company_id AND j.status = 'posted'
          AND ((j.source_type = 'bank_transaction' AND j.source_id = NEW.id)
            OR j.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', NEW.id)))
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

-- public.heal_cash_account_twins: last full definition in 20260921165822_verify_cash_account_twin_repairs, then patched by 20260921174642.
CREATE OR REPLACE FUNCTION public.heal_cash_account_twins(p_company_id uuid, p_expected_fingerprint text, p_operation_id uuid, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_prior public.processing_history;
  v_plan jsonb;
  v_group jsonb;
  v_live public.cash_accounts;
  v_keeper public.cash_accounts;
  v_session text;
  v_retire uuid[];
  v_result jsonb;
  v_expected_state jsonb;
  v_verification jsonb;
  v_receipt_groups jsonb := '[]';
BEGIN
  IF p_operation_id IS NULL OR p_expected_fingerprint IS NULL OR p_expected_fingerprint !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_actor) IS DISTINCT FROM 'object'
    OR p_actor->>'type' IS NULL OR p_actor->>'type' NOT IN ('user','system','cron','api_key','llm')
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_HEAL_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_prior FROM public.processing_history WHERE event_id = p_operation_id;
  IF FOUND THEN
    IF v_prior.company_id IS DISTINCT FROM p_company_id OR v_prior.event_type <> 'CashAccountTwinsMerged'
      OR v_prior.payload->>'plan_fingerprint' IS DISTINCT FROM p_expected_fingerprint
      OR v_prior.payload->>'phase' IS DISTINCT FROM 'completed' OR v_prior.actor IS DISTINCT FROM p_actor
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_ID_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.payload->'result';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.transactions WHERE company_id = p_company_id AND cash_account_id IS NOT NULL ORDER BY id FOR UPDATE;
  v_plan := public.plan_cash_account_twins(p_company_id);
  IF v_plan->>'fingerprint' IS DISTINCT FROM p_expected_fingerprint THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PLAN_CHANGED: nothing written, review the new dry run' USING ERRCODE = 'PT409';
  END IF;
  v_expected_state := public.capture_cash_twin_expected_state(p_company_id, v_plan->'groups');
  FOR v_group IN SELECT a FROM jsonb_array_elements(v_plan->'groups') a WHERE a->>'skipped' IS NULL LOOP
    SELECT * INTO v_live FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_group->>'liveRowId')::uuid;
    SELECT * INTO v_keeper FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_group->'keeper'->>'id')::uuid;
    SELECT session_id INTO v_session FROM public.bank_connections WHERE company_id = p_company_id AND id = v_live.bank_connection_id;
    SELECT coalesce(array_agg((a->>'id')::uuid), '{}') INTO v_retire FROM jsonb_array_elements(v_group->'retired') a;
    PERFORM public.promote_psd2_cash_account(p_company_id, jsonb_build_object(
      'bank_connection_id', v_live.bank_connection_id, 'external_uid', v_live.external_uid,
      'currency', v_live.currency, 'ledger_account', v_keeper.ledger_account, 'iban', v_live.iban,
      'bban', v_live.bban, 'name', coalesce(v_keeper.name, v_live.name), 'enabled', v_live.enabled,
      'reuse_cash_account_id', v_keeper.id, 'expected_session_id', v_session,
      'balance', v_live.balance, 'available_balance', v_live.available_balance, 'balance_updated_at', v_live.balance_updated_at
    ), v_retire);
  END LOOP;
  v_verification := public.check_cash_twin_expected_state(p_company_id, v_expected_state);
  IF v_verification->>'status' IS DISTINCT FROM 'consistent' THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_HEAL_VERIFICATION_FAILED' USING ERRCODE = '23514', DETAIL = v_verification::text;
  END IF;
  -- A receipt contains IDs and ledger identifiers, never an IBAN. It remains
  -- discoverable by operation ID after the final twin is gone.
  SELECT coalesce(jsonb_agg(a - 'physicalKey'), '[]') INTO v_receipt_groups FROM jsonb_array_elements(v_plan->'groups') a;
  v_result := (v_plan - 'groups') || jsonb_build_object('dryRun', false, 'groups', v_receipt_groups, 'operationId', p_operation_id, 'verification', v_verification);
  INSERT INTO public.processing_history(event_id, company_id, correlation_id, aggregate_type, aggregate_id,
    event_type, payload, payload_schema_version, actor, occurred_at)
  VALUES (p_operation_id, p_company_id, p_operation_id, 'System', p_company_id, 'CashAccountTwinsMerged',
    jsonb_build_object('phase', 'completed', 'plan_fingerprint', p_expected_fingerprint, 'result', v_result, 'verification', v_expected_state), 3, p_actor, clock_timestamp());
  RETURN v_result;
END;
$function$
;

-- public.next_voucher_number: last full definition in 20260702093000_rls_role_gate_and_voucher_rpc_guards, then patched by 20260703180000.
CREATE OR REPLACE FUNCTION public.next_voucher_number(p_company_id uuid, p_fiscal_period_id uuid, p_series text DEFAULT 'A'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_next integer;
  v_user_id uuid;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Preserved from 20260623130000: under a service-role client auth.uid() is
  -- NULL and the INSERT would fail user_id NOT NULL before ON CONFLICT
  -- arbitration — fall back to the company owner.
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    SELECT created_by INTO v_user_id
    FROM public.companies
    WHERE id = p_company_id;
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'next_voucher_number: no attributable user for company %', p_company_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, v_user_id, p_fiscal_period_id, p_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  RETURN v_next;
END;
$function$
;

-- public.persist_bank_sync_result: last full definition in 20260921154104_persist_bank_sync_result, then patched by 20260921174830, 20260922122425.
CREATE OR REPLACE FUNCTION public.persist_bank_sync_result(p_company_id uuid, p_connection_id uuid, p_session_id text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_accounts jsonb, p_initial_sync jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_connection public.bank_connections;
  v_account jsonb;
  v_patch jsonb;
  v_next jsonb := '[]'::jsonb;
  v_balance_at timestamptz;
  v_accounts integer := 0;
BEGIN
  IF p_started_at IS NULL OR p_completed_at IS NULL
     OR p_started_at > p_completed_at
     OR p_completed_at > clock_timestamp() + interval '5 minutes'
     OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array'
     OR (p_initial_sync IS NOT NULL AND jsonb_typeof(p_initial_sync) <> 'object') THEN
    RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a
     WHERE jsonb_typeof(a) <> 'object' OR nullif(a->>'uid', '') IS NULL
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a GROUP BY a->>'uid' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID_ACCOUNTS' USING ERRCODE = '22023';
  END IF;


  -- Preserve the invoker's not-found/tenant contract before privileged locking.
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_connections
    WHERE id = p_connection_id AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;
  PERFORM public.lock_cash_account_company(p_company_id);

  -- Re-read connection/session state after waiting, under the invoker's RLS.

  SELECT * INTO v_connection FROM public.bank_connections
   WHERE id = p_connection_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;
  IF v_connection.session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'session_changed');
  END IF;
  IF v_connection.status IS NULL OR v_connection.status NOT IN ('active', 'error')
     OR v_connection.superseded_by IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'connection_inactive');
  END IF;
  IF v_connection.sync_result_started_at > p_started_at THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'newer_result_exists');
  END IF;
  -- A UID removed by reauthorization/sharing cannot be resurrected by a fetch.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) c
        WHERE c->>'uid' = a->>'uid'
     )
  ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'accounts_changed');
  END IF;

  FOR v_account IN SELECT value FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) LOOP
    SELECT value INTO v_patch FROM jsonb_array_elements(p_accounts)
     WHERE value->>'uid' = v_account->>'uid';
    IF FOUND THEN
      v_accounts := v_accounts + 1;
      -- An established external-id scope is immutable across observations.
      IF nullif(v_account->>'dedup_scope', '') IS NOT NULL
         AND nullif(v_patch->>'dedup_scope', '') IS NOT NULL
         AND v_account->>'dedup_scope' <> v_patch->>'dedup_scope' THEN
        RAISE EXCEPTION 'BANK_SYNC_DEDUP_SCOPE_CHANGED' USING ERRCODE = 'PT409';
      END IF;
      IF nullif(v_account->>'dedup_scope', '') IS NULL AND nullif(v_patch->>'dedup_scope', '') IS NOT NULL THEN
        v_account := v_account || jsonb_build_object('dedup_scope', v_patch->>'dedup_scope');
      END IF;
      IF v_patch ? 'accepted_history_days' THEN
        IF (v_patch->>'accepted_history_days')::integer < 0 THEN
          RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID_HISTORY' USING ERRCODE = '22023';
        END IF;
        v_account := v_account || jsonb_build_object('accepted_history_days', greatest(
          coalesce((v_account->>'accepted_history_days')::integer, 0),
          (v_patch->>'accepted_history_days')::integer
        ));
      END IF;
      v_balance_at := (v_patch->>'balance_updated_at')::timestamptz;
      IF v_balance_at IS NOT NULL AND v_balance_at <= p_completed_at + interval '5 minutes'
         AND (nullif(v_account->>'balance_updated_at', '') IS NULL
           OR v_balance_at >= (v_account->>'balance_updated_at')::timestamptz) THEN
        -- Whitelist observations: never accept ledger, enabled, IBAN or name.
        IF v_patch ? 'balance' THEN
          v_account := v_account || jsonb_build_object('balance', (v_patch->>'balance')::numeric);
        END IF;
        v_account := v_account || jsonb_build_object(
          'available_balance', (v_patch->>'available_balance')::numeric,
          'balance_updated_at', v_balance_at
        );
        UPDATE public.cash_accounts
           SET balance = CASE WHEN v_patch ? 'balance' THEN (v_patch->>'balance')::numeric ELSE balance END,
               available_balance = (v_patch->>'available_balance')::numeric,
               balance_updated_at = v_balance_at
         WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
           AND external_uid = v_account->>'uid'
           AND (balance_updated_at IS NULL OR balance_updated_at <= v_balance_at);
      END IF;
    END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;

  UPDATE public.bank_connections
     SET accounts_data = v_next,
         sync_result_started_at = p_started_at,
         last_synced_at = greatest(last_synced_at, p_completed_at),
         status = 'active', error_message = NULL,
         initial_sync_completed_at = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN p_completed_at ELSE initial_sync_completed_at END,
         initial_sync_requested_from = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'requested_from')::date ELSE initial_sync_requested_from END,
         initial_sync_returned_min_date = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'returned_min')::date ELSE initial_sync_returned_min_date END,
         initial_sync_returned_max_date = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'returned_max')::date ELSE initial_sync_returned_max_date END,
         initial_sync_lookback_days = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'lookback_days')::integer ELSE initial_sync_lookback_days END
   WHERE id = p_connection_id AND company_id = p_company_id;
  RETURN jsonb_build_object('applied', true, 'account_count', v_accounts);
END;
$function$
;

-- public.relink_stranded_transactions: last full definition in 20260921230500_relink_bank_rows_after_sie_import, then patched by 20260922090239.
CREATE OR REPLACE FUNCTION public.relink_stranded_transactions(p_company_id uuid, p_dry_run boolean DEFAULT true, p_pair_balanced_groups boolean DEFAULT false, p_actor jsonb DEFAULT NULL::jsonb, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(transaction_id uuid, transaction_date date, amount numeric, currency text, ledger_account text, lock_state text, competing_rows integer, candidate_lines integer, outcome text, journal_entry_id uuid, selected boolean, relinked boolean)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
-- The result columns share names with table columns (amount, currency,
-- journal_entry_id, ...); inside the query a bare name always means the column.
#variable_conflict use_column
DECLARE
  v_correlation_id uuid := COALESCE(p_correlation_id, gen_random_uuid());
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'relink_stranded_transactions: p_company_id is required, this never runs across companies'
      USING ERRCODE = '22023';
  END IF;
  IF NOT p_dry_run AND (
       p_actor IS NULL
       OR jsonb_typeof(p_actor) <> 'object'
       OR COALESCE(p_actor->>'type', '') = ''
       OR COALESCE(p_actor->>'id', '') = '') THEN
    RAISE EXCEPTION 'relink_stranded_transactions: p_actor {type, id} is required for a write'
      USING ERRCODE = '22023';
  END IF;

  IF NOT p_dry_run THEN
    PERFORM public.lock_cash_account_company(p_company_id);
  END IF;

  RETURN QUERY
  WITH primary_account AS (
    SELECT ca.ledger_account
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id AND ca.is_primary
    LIMIT 1
  ),
  -- Every bank row that still needs a verifikat, stranded or not: an open row
  -- with the same key competes for the same line and makes the pairing a guess.
  unbooked AS (
    SELECT
      t.id,
      t.date,
      t.amount,
      t.currency,
      t.category,
      t.reconciliation_method,
      (t.is_business IS TRUE) AS is_stranded,
      -- Same attribution as the unattended sweep: a row with no cash account
      -- belongs to the primary account; a company with none reconciles on 1930.
      COALESCE(ca.ledger_account, (SELECT pa.ledger_account FROM primary_account pa), '1930') AS ledger_account,
      (t.currency = 'SEK' AND COALESCE(ca.currency, 'SEK') = 'SEK') AS is_sek
    FROM public.transactions t
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id AND ca.company_id = t.company_id
    WHERE t.company_id = p_company_id
      AND t.is_ignored = false
      AND t.journal_entry_id IS NULL
      AND NOT public.is_transaction_booked(t.id)
  ),
  -- The matcher's candidate set (get_unlinked_gl_lines), for every 19xx account.
  free_lines AS (
    SELECT
      jel.id AS line_id,
      je.id AS entry_id,
      jel.account_number,
      je.entry_date,
      je.voucher_series,
      je.voucher_number,
      round(jel.debit_amount - jel.credit_amount, 2) AS signed_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.source_type IS DISTINCT FROM 'opening_balance'
      AND je.source_type IS DISTINCT FROM 'storno'
      AND je.source_type IS DISTINCT FROM 'correction'
      AND jel.account_number LIKE '19%'
      AND round(jel.debit_amount - jel.credit_amount, 2) <> 0
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions lt
        WHERE lt.journal_entry_id = je.id AND lt.company_id = p_company_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.transaction_voucher_links l
        WHERE l.journal_entry_id = je.id AND l.company_id = p_company_id)
  ),
  ranked_rows AS (
    SELECT u.*,
      count(*) OVER w AS competing_rows,
      bool_and(u.is_stranded) OVER w AS all_stranded,
      row_number() OVER (PARTITION BY u.ledger_account, u.date, round(u.amount, 2) ORDER BY u.id) AS pair_no
    FROM unbooked u
    WINDOW w AS (PARTITION BY u.ledger_account, u.date, round(u.amount, 2))
  ),
  ranked_lines AS (
    SELECT f.*,
      count(*) OVER (PARTITION BY f.account_number, f.entry_date, f.signed_amount) AS candidate_lines,
      row_number() OVER (PARTITION BY f.account_number, f.entry_date, f.signed_amount
        ORDER BY f.voucher_series, f.voucher_number, f.line_id) AS pair_no
    FROM free_lines f
  ),
  line_counts AS (
    SELECT DISTINCT f.account_number, f.entry_date, f.signed_amount, f.candidate_lines
    FROM ranked_lines f
  ),
  judged AS (
    SELECT
      r.id,
      r.date,
      r.amount,
      r.currency,
      r.category,
      r.reconciliation_method,
      r.ledger_account,
      r.competing_rows::integer AS competing_rows,
      COALESCE(lc.candidate_lines, 0)::integer AS candidate_lines,
      CASE
        WHEN NOT r.is_sek THEN 'unsupported_currency'
        WHEN COALESCE(lc.candidate_lines, 0) = 0 THEN 'no_counterpart'
        WHEN r.competing_rows = 1 AND lc.candidate_lines = 1 THEN 'unique'
        WHEN r.competing_rows = lc.candidate_lines AND r.all_stranded THEN 'balanced_group'
        ELSE 'ambiguous'
      END AS outcome,
      r.pair_no
    FROM ranked_rows r
    LEFT JOIN line_counts lc
      ON lc.account_number = r.ledger_account
     AND lc.entry_date = r.date
     AND lc.signed_amount = round(r.amount, 2)
    WHERE r.is_stranded
  ),
  paired AS (
    SELECT j.*,
      CASE WHEN j.outcome IN ('unique', 'balanced_group') THEN rl.entry_id END AS entry_id,
      (j.outcome = 'unique' OR (j.outcome = 'balanced_group' AND p_pair_balanced_groups)) AS selected,
      CASE
        WHEN cs.bookkeeping_locked_through IS NOT NULL
             AND j.date <= cs.bookkeeping_locked_through THEN 'company_lock_date'
        WHEN fp.id IS NULL THEN 'no_period'
        WHEN fp.is_closed THEN 'closed'
        WHEN fp.locked_at IS NOT NULL THEN 'locked'
        ELSE 'open'
      END AS lock_state
    FROM judged j
    LEFT JOIN ranked_lines rl
      ON rl.account_number = j.ledger_account
     AND rl.entry_date = j.date
     AND rl.signed_amount = round(j.amount, 2)
     AND rl.pair_no = j.pair_no
    LEFT JOIN public.company_settings cs ON cs.company_id = p_company_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.is_closed, p.locked_at
      FROM public.fiscal_periods p
      WHERE p.company_id = p_company_id
        AND p.period_start <= j.date
        AND p.period_end >= j.date
      ORDER BY p.period_start DESC
      LIMIT 1
    ) fp ON true
  ),
  updated AS (
    UPDATE public.transactions t
    SET journal_entry_id = g.entry_id,
        reconciliation_method = 'auto_exact',
        updated_at = now()
    FROM paired g
    WHERE NOT p_dry_run
      AND g.selected
      AND g.entry_id IS NOT NULL
      AND t.id = g.id
      AND t.company_id = p_company_id
      -- Re-asserted inside the write: a row that was booked, released or
      -- ignored between the scan and the update is left exactly as it is.
      AND t.is_business = true
      AND t.is_ignored = false
      AND t.journal_entry_id IS NULL
      AND NOT public.is_transaction_booked(t.id)
    RETURNING t.id
  ),
  logged AS (
    INSERT INTO public.processing_history
      (company_id, correlation_id, aggregate_type, aggregate_id, event_type,
       payload, actor, occurred_at)
    SELECT
      p_company_id,
      v_correlation_id,
      'BankTransaction',
      g.id,
      'BankTransactionStrandedRelinked',
      jsonb_build_object(
        'issue', 2835,
        'rule', CASE g.outcome WHEN 'unique' THEN 'auto_exact_unique' ELSE 'auto_exact_balanced_group' END,
        'lock_state', g.lock_state,
        'previous', jsonb_build_object(
          'journal_entry_id', NULL,
          'reconciliation_method', g.reconciliation_method
        ),
        'after', jsonb_build_object(
          'journal_entry_id', g.entry_id,
          'reconciliation_method', 'auto_exact'
        )
      ),
      p_actor,
      now()
    FROM paired g
    JOIN updated u ON u.id = g.id
    RETURNING aggregate_id
  )
  SELECT
    g.id,
    g.date,
    g.amount,
    g.currency,
    g.ledger_account,
    g.lock_state,
    g.competing_rows,
    g.candidate_lines,
    g.outcome,
    g.entry_id,
    g.selected,
    (u.id IS NOT NULL) AS relinked
  FROM paired g
  LEFT JOIN updated u ON u.id = g.id
  ORDER BY g.date, g.id;
END;
$function$
;

-- public.resolve_bank_ingest_route: last full definition in 20260921155646_guard_bank_transaction_routing, then patched by 20260921174830.
CREATE OR REPLACE FUNCTION public.resolve_bank_ingest_route(p_company_id uuid, p_connection_id uuid, p_account_uid text, p_currency text, p_lock boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_connection public.bank_connections;
  v_cash public.cash_accounts;
  v_account jsonb;
  v_token text;
BEGIN
  IF p_lock THEN
    SELECT * INTO v_connection FROM public.bank_connections
     WHERE company_id = p_company_id AND id = p_connection_id FOR SHARE;
  ELSE
    SELECT * INTO v_connection FROM public.bank_connections
     WHERE company_id = p_company_id AND id = p_connection_id;
  END IF;
  IF v_connection.id IS NULL OR v_connection.status IS NULL
     OR v_connection.status NOT IN ('active', 'error') OR v_connection.superseded_by IS NOT NULL
     OR nullif(v_connection.session_id, '') IS NULL THEN
    RAISE EXCEPTION 'BANK_INGEST_CONNECTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) a
       WHERE a->>'uid' = p_account_uid) <> 1 THEN
    RAISE EXCEPTION 'BANK_INGEST_ACCOUNT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  SELECT value INTO v_account FROM jsonb_array_elements(v_connection.accounts_data)
   WHERE value->>'uid' = p_account_uid;
  IF coalesce((v_account->>'enabled')::boolean, true) IS NOT TRUE
     OR upper(v_account->>'currency') IS DISTINCT FROM upper(p_currency) THEN
    RAISE EXCEPTION 'BANK_INGEST_ACCOUNT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF p_lock THEN
    SELECT * INTO v_cash FROM public.cash_accounts
     WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
       AND external_uid = p_account_uid FOR SHARE;
  ELSE
    SELECT * INTO v_cash FROM public.cash_accounts
     WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
       AND external_uid = p_account_uid;
  END IF;
  IF v_cash.id IS NULL OR v_cash.enabled IS NOT TRUE
     OR upper(v_cash.currency) IS DISTINCT FROM upper(p_currency)
     OR v_account->>'ledger_account' IS DISTINCT FROM v_cash.ledger_account THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_UNRESOLVED' USING ERRCODE = 'PT409';
  END IF;
  -- A matching ledger is insufficient when the account identity itself drifted.
  IF nullif(regexp_replace(v_account->>'iban', '\s', '', 'g'), '') IS NOT NULL
     AND upper(regexp_replace(v_account->>'iban', '\s', '', 'g'))
       IS DISTINCT FROM upper(regexp_replace(v_cash.iban, '\s', '', 'g')) THEN
    RAISE EXCEPTION 'BANK_INGEST_IDENTITY_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  v_token := md5(jsonb_build_array('bank-route-v1', p_company_id, v_connection.id,
    v_connection.session_id, p_account_uid, v_cash.id, v_cash.ledger_account,
    upper(v_cash.currency), upper(regexp_replace(v_cash.iban, '\s', '', 'g')),
    v_cash.bban, v_cash.enabled, v_account->>'enabled')::text);
  RETURN jsonb_build_object('connectionId', v_connection.id, 'sessionId', v_connection.session_id,
    'accountUid', p_account_uid, 'cashAccountId', v_cash.id, 'ledgerAccount', v_cash.ledger_account,
    'currency', upper(v_cash.currency), 'token', v_token);
END;
$function$
;

-- public.rotate_company_inbox: last full definition in 20260619130100_securitydefiner_write_rpc_tenant_guards, then patched by 20260703180000.
CREATE OR REPLACE FUNCTION public.rotate_company_inbox(p_company_id uuid)
 RETURNS company_inboxes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_company_name text;
  v_local_part text;
  v_slug_seed text;
  v_new_row public.company_inboxes;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Authorization: caller must be owner/admin of the company.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized to rotate inbox for this company'
      USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_company_name
  FROM public.companies
  WHERE id = p_company_id;

  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002';
  END IF;

  -- All three steps share one transaction — a failure on any of them
  -- rolls the whole thing back, so the company never ends up without
  -- an active inbox.

  UPDATE public.company_inboxes
  SET status = 'deprecated',
      deprecated_at = now()
  WHERE company_id = p_company_id
    AND status = 'active';

  v_local_part := public.generate_inbox_local_part(v_company_name);
  v_slug_seed := regexp_replace(v_local_part, '-[^-]+$', '');

  INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
  VALUES (p_company_id, v_local_part, v_slug_seed, 'active')
  RETURNING * INTO v_new_row;

  RETURN v_new_row;
END;
$function$
;
