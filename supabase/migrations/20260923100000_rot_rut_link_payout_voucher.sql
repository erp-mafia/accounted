-- Rot & rut: link a begäran to a payout verifikat that already exists, and
-- release the link when that verifikat is reversed.
--
-- A begäran counts as settled when settlement_journal_entry_id points at a
-- live verifikat (lib/invoices/rot-rut-payout-matching.ts). Until now only
-- the settle flow wrote that pointer, and only for a verifikat it booked
-- itself. A payout booked by hand (for example 1930 / 3740 öresavrundning /
-- 1513, because the begäran was truncated to whole kronor) had no way in: the
-- begäran stayed "Uppladdad" forever and the fix was SQL.
--
-- link_rot_rut_payout_voucher attaches the posted verifikat to one begäran,
-- or to several when one transfer paid them all, in one transaction:
--
--   - the ONLY writes are the begäran rows (pointer, status, decided_total,
--     decided_at) and, for a fully paid begäran, the items' decided_amount
--     (the same mirror the settle flow writes). No journal table is touched;
--   - the verifikat must be posted, not reversed, not a storno or an IB, and
--     in the same company;
--   - its net 1513 credit must cover what the begäran expect
--     (decided_total, else requested_total) and may exceed it by less than
--     1 kr per invoice: the begäran file truncates each invoice to whole
--     kronor (lib/invoices/rot-rut-file.ts), so a verifikat that clears the
--     full receivable carries that öre remainder. Anything further off is a
--     different payout, or a bundle with a begäran missing, and is refused;
--   - a begäran already linked elsewhere, cancelled or rejected is refused,
--     and so is a verifikat another begäran already uses. Running the same
--     link again is a no-op that answers ok.
--
-- SECURITY INVOKER, like attach_supplier_invoice_settlement_voucher: RLS
-- already scopes which begäran and verifikat the caller can see, so a foreign
-- company reads as not found. service_role (MCP) bypasses RLS, which is why
-- every query also filters on p_company_id.
--
-- p_dry_run runs every check and returns what would be written, so the MCP
-- stage previews against the same rules the approval is judged by. An
-- explicit NULL is treated as a dry run.
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
  IF v_credit < v_expected - 0.005
     OR v_credit > v_expected + 0.99 * GREATEST(v_item_count, 1) + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ROT_RUT_LINK_AMOUNT_MISMATCH',
      'details', jsonb_build_object('expected_total', v_expected, 'voucher_1513_credit', v_credit,
                                    'invoice_count', v_item_count));
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
    'bank_amount', v_bank,
    'rounding', ROUND((v_credit - v_expected) * 100) / 100,
    'requests', v_requests
  );
END;
$$;

REVOKE ALL ON FUNCTION public.link_rot_rut_payout_voucher(uuid, uuid[], uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_rot_rut_payout_voucher(uuid, uuid[], uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_rot_rut_payout_voucher(uuid, uuid[], uuid, boolean) IS
  'Link one or several ROT/RUT begäran to a posted payout verifikat that already exists. Writes the begäran rows (settlement pointer, status, decided_total/decided_at) and the fully paid items'' decided_amount; never touches the journal. The net 1513 credit must cover the expected payout and exceed it by less than 1 kr per invoice. Idempotent. p_dry_run checks without writing.';

-- =============================================================================
-- Release the link when the settlement verifikat is reversed.
--
-- reverseEntry() flips the cancelled verifikat to status 'reversed'. A begäran
-- still pointing at it read as settled, so it could never be settled again:
-- the live-unique index (20260904021000) lets a new payout verifikat in, but
-- the settle guard refused on the stale pointer. Clearing the pointer is the
-- whole release: settled means "has a live settlement verifikat", and status
-- plus decided_* are Skatteverkets beslut, which the storno does not undo.
-- A trigger rather than a hook in reverseEntry(), so every reversal path is
-- covered in the same transaction. SECURITY DEFINER because the row to clear
-- is derived from the reversed verifikat alone and RLS must not hide it.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.release_rot_rut_settlement_on_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.rot_rut_payout_requests
  SET settlement_journal_entry_id = NULL
  WHERE company_id = NEW.company_id
    AND settlement_journal_entry_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.release_rot_rut_settlement_on_reversal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS release_rot_rut_settlement_on_reversal ON public.journal_entries;
CREATE TRIGGER release_rot_rut_settlement_on_reversal
  AFTER UPDATE OF status ON public.journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed')
  EXECUTE FUNCTION public.release_rot_rut_settlement_on_reversal();

NOTIFY pgrst, 'reload schema';
