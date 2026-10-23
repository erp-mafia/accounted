-- Rot & rut: link a begäran to a payout verifikat booked by hand the
-- kontantmetod two-step way (#93).
--
-- Under kontantmetoden a ROT/RUT invoice is booked in two steps (!773,
-- docs/decisions/2026-10/2026-10-22-rot-rut-moms-two-steps.md; ML 2023:200
-- 7 kap. 16 §; Skatteverket, "Så fungerar rotavdraget"): the customer's
-- payment books the customer's share, and Skatteverket's share is booked as
-- försäljning and utgående moms when its payout arrives. 1513 holds nothing
-- during the year. A payout booked by hand that way (1930 or the skattekonto
-- against revenue and moms) credits no 1513, so link_rot_rut_payout_voucher
-- (20260923100000) refused it with ROT_RUT_LINK_AMOUNT_MISMATCH and the
-- begäran read "Uppladdad" forever.
--
-- This replaces the function with the same rules plus one alternative,
-- tried only when the 1513 credit does not cover the begäran: the two-step
-- shape, accepted only when ALL hold, so a customer payment or a sale of the
-- same amount is never taken for a payout:
--   - the company is on kontantmetoden (company_settings.accounting_method);
--   - the verifikat is a hand-booked one: source_type manual, bank_transaction,
--     system (a skattekonto row) or correction, never a document's own
--     verifikat (invoice_cash_payment, invoice_paid, ...);
--   - every line is on the money-in account (19xx, or the skattekonto 1630 /
--     2012 for a set-off), 1513, revenue (3xxx but 3740), utgående moms
--     (261x-263x) or 3740 öresavrundning, with some revenue or moms credited;
--   - the money in is exactly what the begäran expect (decided_total, else
--     requested_total): Skatteverket pays the decided sum;
--   - 1513 plus that revenue and moms covers it within the same öre
--     tolerance as the 1513 credit.
-- The result also carries share_credit (the revenue and moms counted), and
-- rounding is measured on 1513 plus the share. Everything else, the writes
-- included, is unchanged; no journal table is touched.
--
-- pg-test: tests/pg/rot-rut-link-payout-voucher.pg.test.ts

CREATE OR REPLACE FUNCTION public.link_rot_rut_payout_voucher(
  p_company_id uuid,
  p_request_ids uuid[],
  p_journal_entry_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_dry_run boolean := COALESCE(p_dry_run, true);
  v_ids uuid[];
  v_voucher RECORD;
  v_request RECORD;
  v_found integer;
  v_linked_here integer;
  v_other_users integer;
  v_expected numeric := 0;
  v_item_count integer;
  v_credit numeric;
  v_bank numeric;
  v_amount numeric;
  v_requests jsonb := '[]'::jsonb;
  v_method text;
  v_money_in numeric := 0;
  v_share numeric := 0;
  v_other_lines integer := 0;
  v_covered numeric;
BEGIN
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids
  FROM unnest(p_request_ids) AS x
  WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_REQUEST_NOT_FOUND');
  END IF;

  -- Serialise on the verifikat first: two calls linking it to two different
  -- begäran would otherwise both pass the "not used elsewhere" check. Then
  -- the begäran rows in id order, so two overlapping bundles cannot deadlock.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('rot-rut-payout-voucher:' || p_journal_entry_id::text, 0)
  );

  SELECT count(*) INTO v_found
  FROM (
    SELECT id
    FROM public.rot_rut_payout_requests
    WHERE company_id = p_company_id AND id = ANY (v_ids)
    ORDER BY id
    FOR UPDATE
  ) AS locked;

  IF v_found <> array_length(v_ids, 1) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_REQUEST_NOT_FOUND');
  END IF;

  SELECT id, status, source_type, entry_date, voucher_series, voucher_number,
         description, reversed_by_id
  INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_LINK_VOUCHER_NOT_FOUND');
  END IF;

  -- Idempotency before every state check: the same link run twice answers
  -- ok, not "already settled".
  SELECT count(*) FILTER (WHERE id = ANY (v_ids)),
         count(*) FILTER (WHERE NOT (id = ANY (v_ids)))
  INTO v_linked_here, v_other_users
  FROM public.rot_rut_payout_requests
  WHERE company_id = p_company_id
    AND settlement_journal_entry_id = p_journal_entry_id;

  IF v_linked_here = array_length(v_ids, 1) AND v_other_users = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dry_run', v_dry_run,
      'already_linked', true,
      'journal_entry_id', p_journal_entry_id
    );
  END IF;

  IF v_other_users > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_LINK_VOUCHER_IN_USE');
  END IF;

  IF v_voucher.status <> 'posted' OR v_voucher.reversed_by_id IS NOT NULL
     OR v_voucher.source_type IN ('storno', 'opening_balance') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_LINK_VOUCHER_NOT_ELIGIBLE',
      'details', jsonb_build_object('status', v_voucher.status, 'source_type', v_voucher.source_type));
  END IF;

  FOR v_request IN
    SELECT id, name, status, requested_total, decided_total, settlement_journal_entry_id
    FROM public.rot_rut_payout_requests
    WHERE company_id = p_company_id AND id = ANY (v_ids)
    ORDER BY id
  LOOP
    IF v_request.settlement_journal_entry_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_LINK_ALREADY_SETTLED',
        'details', jsonb_build_object('request_id', v_request.id, 'name', v_request.name,
                                      'journal_entry_id', v_request.settlement_journal_entry_id));
    END IF;
    IF v_request.status IN ('cancelled', 'rejected') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_SETTLE_INVALID_STATE',
        'details', jsonb_build_object('request_id', v_request.id, 'name', v_request.name,
                                      'status', v_request.status));
    END IF;
    v_expected := v_expected + COALESCE(v_request.decided_total, v_request.requested_total);
  END LOOP;
  v_expected := ROUND(v_expected * 100) / 100;

  SELECT count(*) INTO v_item_count
  FROM public.rot_rut_payout_request_items
  WHERE request_id = ANY (v_ids);

  SELECT ROUND(COALESCE(SUM(credit_amount - debit_amount)
                 FILTER (WHERE account_number = '1513'), 0) * 100) / 100,
         ROUND(COALESCE(SUM(debit_amount - credit_amount)
                 FILTER (WHERE account_number LIKE '19%'), 0) * 100) / 100
  INTO v_credit, v_bank
  FROM public.journal_entry_lines
  WHERE journal_entry_id = p_journal_entry_id;

  -- At least what the begäran expect, and less than 1 kr more per invoice
  -- (the whole-kronor truncation of each invoice in the begäran file).
  v_covered := v_credit;
  IF v_credit < v_expected - 0.005
     OR v_credit > v_expected + 0.99 * GREATEST(v_item_count, 1) + 0.005 THEN
    -- Kontantmetodens two steps (#93): 1513 holds nothing during the year,
    -- so a payout booked by hand credits Skatteverket's share as revenue
    -- (3xxx but 3740) and utgående moms (261x-263x) instead. Accepted only
    -- in exactly that shape: the company is on kontantmetoden; the voucher
    -- is a hand-booked one (manual, bank row, skattekonto row, rättelse),
    -- never a document's own verifikat such as a customer payment; every
    -- line is on the money-in account (19xx, or the skattekonto 1630 / 2012
    -- on a set-off), 1513, revenue, utgående moms or 3740; the money in is
    -- exactly what the begäran expect; and 1513 plus the share covers it
    -- like the 1513 credit above.
    SELECT accounting_method INTO v_method
    FROM public.company_settings
    WHERE company_id = p_company_id;

    SELECT ROUND(COALESCE(SUM(debit_amount - credit_amount)
                   FILTER (WHERE account_number LIKE '19%' OR account_number IN ('1630', '2012')), 0) * 100) / 100,
           ROUND(COALESCE(SUM(credit_amount - debit_amount)
                   FILTER (WHERE (account_number LIKE '3%' AND account_number <> '3740')
                              OR account_number LIKE '261%' OR account_number LIKE '262%'
                              OR account_number LIKE '263%'), 0) * 100) / 100,
           count(*) FILTER (WHERE NOT (account_number LIKE '19%' OR account_number IN ('1630', '2012', '1513', '3740')
                                       OR account_number LIKE '3%' OR account_number LIKE '261%'
                                       OR account_number LIKE '262%' OR account_number LIKE '263%'))
    INTO v_money_in, v_share, v_other_lines
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id;

    v_covered := ROUND((v_credit + v_share) * 100) / 100;
    IF v_method IS DISTINCT FROM 'cash'
       OR COALESCE(v_voucher.source_type, '') NOT IN ('manual', 'bank_transaction', 'system', 'correction')
       OR v_other_lines > 0
       OR v_share <= 0
       OR abs(v_money_in - v_expected) > 0.005
       OR v_covered < v_expected - 0.005
       OR v_covered > v_expected + 0.99 * GREATEST(v_item_count, 1) + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_LINK_AMOUNT_MISMATCH',
        'details', jsonb_build_object('expected_total', v_expected, 'voucher_1513_credit', v_credit,
                                      'invoice_count', v_item_count));
    END IF;
  END IF;

  FOR v_request IN
    SELECT id, name, status, requested_total, decided_total, decided_at
    FROM public.rot_rut_payout_requests
    WHERE company_id = p_company_id AND id = ANY (v_ids)
    ORDER BY id
  LOOP
    v_amount := COALESCE(v_request.decided_total, v_request.requested_total);

    IF NOT v_dry_run THEN
      UPDATE public.rot_rut_payout_requests
      SET settlement_journal_entry_id = p_journal_entry_id,
          status = CASE WHEN v_amount >= requested_total THEN 'paid' ELSE 'partially_paid' END,
          decided_total = v_amount,
          decided_at = COALESCE(decided_at, now())
      WHERE id = v_request.id AND company_id = p_company_id;

      -- A fully paid begäran mirrors requested_amount onto every item, as
      -- the settle flow does (mirrorDecidedAmounts).
      IF v_amount >= v_request.requested_total THEN
        UPDATE public.rot_rut_payout_request_items
        SET decided_amount = requested_amount
        WHERE request_id = v_request.id
          AND decided_amount IS DISTINCT FROM requested_amount;
      END IF;
    END IF;

    v_requests := v_requests || jsonb_build_object(
      'request_id', v_request.id,
      'name', v_request.name,
      'amount', v_amount,
      'status', CASE WHEN v_amount >= v_request.requested_total THEN 'paid' ELSE 'partially_paid' END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', v_dry_run,
    'already_linked', false,
    'journal_entry_id', p_journal_entry_id,
    'voucher', jsonb_build_object(
      'entry_date', v_voucher.entry_date,
      'voucher_series', v_voucher.voucher_series,
      'voucher_number', v_voucher.voucher_number,
      'description', v_voucher.description
    ),
    'expected_total', v_expected,
    'voucher_1513_credit', v_credit,
    'share_credit', v_share,
    'bank_amount', v_bank,
    'rounding', ROUND((v_covered - v_expected) * 100) / 100,
    'requests', v_requests
  );
END;
$$;

REVOKE ALL ON FUNCTION public.link_rot_rut_payout_voucher(uuid, uuid[], uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_rot_rut_payout_voucher(uuid, uuid[], uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_rot_rut_payout_voucher(uuid, uuid[], uuid, boolean) IS
  'Link one or several ROT/RUT begäran to a posted payout verifikat that already exists. Writes the begäran rows (settlement pointer, status, decided_total/decided_at) and the fully paid items'' decided_amount; never touches the journal. The net 1513 credit must cover the expected payout and exceed it by less than 1 kr per invoice; under kontantmetoden a hand-booked two-step payout (money in exactly the expected payout, against 1513, revenue and utgående moms only) qualifies too. Idempotent. p_dry_run checks without writing.';

NOTIFY pgrst, 'reload schema';
