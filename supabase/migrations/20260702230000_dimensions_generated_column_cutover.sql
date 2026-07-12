-- Dimensions PR9 (cutover): the dual-write window ends. The legacy TEXT
-- mirror columns journal_entry_lines.cost_center/project become GENERATED
-- ALWAYS ... STORED, derived from the dimensions JSONB (keys '1'/'6') —
-- divergence is now impossible by construction instead of by convention.
--
-- Ordering contract with the application (dev_docs plan §7 row 9):
--   * TS writers (engine, storno, SIE import) stopped sending the mirror
--     keys in the SAME PR — after this migration an explicit write to
--     either column errors ("cannot insert a non-DEFAULT value into column
--     ... generated always").
--   * The two SQL writers are redefined HERE, atomically with the column
--     swap: retag_line_dimensions (stops SET-ing mirrors — they recompute)
--     and bulk_book_transactions (stops inserting mirror columns).
--   * Readers are untouched: generated columns SELECT exactly like the TEXT
--     columns did, with identical values (NULLIF(dims->>N,'') is the same
--     derivation lineDimensionColumns/the RPCs used).
--
-- The immutability carve-out (20260702170000) needs NO change: its
-- whole-row diff subtracts 'dimensions', 'cost_center' and 'project' from
-- both to_jsonb(NEW) and to_jsonb(OLD), so the fact that BEFORE-trigger NEW
-- carries not-yet-recomputed generated values is irrelevant.
--
-- Operational: DROP COLUMN is metadata-only; the ADD ... STORED pair is ONE
-- table rewrite (~594k rows / 148 MB on prod at cutover time — seconds of
-- exclusive lock; apply off-peak). The pre-flight below refuses to cut over
-- if any row's mirrors have drifted from the bag (prod verified 0 drift).
--
-- pg-test: tests/pg/dimensions-generated-cutover.pg.test.ts.

-- ── 0. Pre-flight: refuse to cut over on drifted data ─────────────────────
DO $$
DECLARE
  v_drift bigint;
BEGIN
  SELECT count(*) INTO v_drift
    FROM public.journal_entry_lines
   WHERE cost_center IS DISTINCT FROM NULLIF(dimensions ->> '1', '')
      OR project     IS DISTINCT FROM NULLIF(dimensions ->> '6', '');
  IF v_drift > 0 THEN
    RAISE EXCEPTION 'dimension mirror drift on % row(s) — reconcile before the generated-column cutover', v_drift;
  END IF;
END
$$;

-- ── 1. Column swap ────────────────────────────────────────────────────────
ALTER TABLE public.journal_entry_lines
  DROP COLUMN cost_center,
  DROP COLUMN project;

ALTER TABLE public.journal_entry_lines
  ADD COLUMN cost_center text GENERATED ALWAYS AS (NULLIF(dimensions ->> '1', '')) STORED,
  ADD COLUMN project     text GENERATED ALWAYS AS (NULLIF(dimensions ->> '6', '')) STORED;

COMMENT ON COLUMN public.journal_entry_lines.cost_center IS
  'GENERATED from dimensions->>''1'' (SIE #DIM 1 object code) since the PR9 cutover — read-only mirror, write the dimensions bag instead.';
COMMENT ON COLUMN public.journal_entry_lines.project IS
  'GENERATED from dimensions->>''6'' (SIE #DIM 6 object code) since the PR9 cutover — read-only mirror, write the dimensions bag instead.';

-- ── 2. retag_line_dimensions: stop SET-ing the mirrors ────────────────────
-- Body byte-identical to 20260702170000 except the UPDATE writes only the
-- bag (the generated mirrors recompute). CREATE OR REPLACE resets proconfig
-- — SET search_path restated; grants restated for auditability.
CREATE OR REPLACE FUNCTION public.retag_line_dimensions(
  p_company_id uuid,
  p_line_id    uuid,
  p_dimensions jsonb,
  p_reason     text,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role   text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor      uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role text;
  v_line       record;
  v_is_closed  boolean;
  v_locked_at  timestamptz;
  v_lock_date  date;
  v_key        text;
  v_value      text;
  v_log_id     uuid;
BEGIN
  -- Tenant guard (20260619130100 pattern): anon/authenticated JWTs must be
  -- members; service_role/no-JWT callers are scoped by the application layer.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Writer gate: any member except viewers (Fortnox parity — retag is
  -- ordinary bookkeeping work, not an admin operation).
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan ändra dimensioner.';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Ange en anledning till ändringen (minst 3 tecken).';
  END IF;

  IF p_dimensions IS NULL OR jsonb_typeof(p_dimensions) <> 'object' THEN
    RAISE EXCEPTION 'Dimensionerna måste vara ett objekt ({"1":"KS01","6":"P001"}).';
  END IF;

  -- Lock the line + parent entry state.
  SELECT jel.id, jel.dimensions, je.id AS entry_id, je.status, je.entry_date,
         je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_line
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE jel.id = p_line_id
     FOR UPDATE OF jel;

  IF NOT FOUND OR v_line.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationsraden hittades inte.';
  END IF;

  IF v_line.status <> 'posted' THEN
    RAISE EXCEPTION 'Endast rader på bokförda verifikat kan taggas om (utkast redigeras direkt).';
  END IF;

  -- Tier boundaries: open periods only, company lock date honored.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_line.fiscal_period_id;

  IF v_is_closed THEN
    RAISE EXCEPTION 'Perioden är stängd — använd rättelseverifikat (storno) för att ändra dimensioner.';
  END IF;
  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är låst — använd rättelseverifikat (storno) för att ändra dimensioner.';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_line.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. % — använd rättelseverifikat (storno).', v_lock_date;
  END IF;

  -- Validate every (dimension, code) pair against the ACTIVE registry.
  -- Retag is a deliberate act on history — unlike import passthrough it
  -- must reference real, active registry values (same posture as the
  -- engine's soft validation for NEW entries).
  FOR v_key, v_value IN SELECT key, value FROM jsonb_each_text(p_dimensions)
  LOOP
    IF v_key !~ '^[1-9][0-9]{0,3}$' THEN
      RAISE EXCEPTION 'Ogiltigt dimensionsnummer: %.', v_key;
    END IF;
    IF v_value IS NULL OR length(btrim(v_value)) = 0 THEN
      RAISE EXCEPTION 'Dimension % saknar kod.', v_key;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.dimensions d
        JOIN public.dimension_values dv
          ON dv.dimension_id = d.id AND dv.company_id = d.company_id
       WHERE d.company_id = p_company_id
         AND d.sie_dim_no = v_key::int
         AND d.is_active
         AND dv.code = v_value
         AND dv.is_active
    ) THEN
      RAISE EXCEPTION 'Värdet "%" finns inte som aktivt värde för dimension % — registrera eller återaktivera det först.', v_value, v_key;
    END IF;
  END LOOP;

  -- Idempotent no-op: nothing to log, nothing to write.
  IF v_line.dimensions = p_dimensions THEN
    RETURN jsonb_build_object('changed', false, 'log_id', NULL);
  END IF;

  -- Immutable before/after audit row FIRST — the trigger carve-out is only
  -- ever exercised in a transaction that has already recorded the change.
  INSERT INTO public.dimension_retag_log
    (company_id, journal_entry_id, line_id, old_dimensions, new_dimensions, actor, reason)
  VALUES
    (p_company_id, v_line.entry_id, p_line_id, v_line.dimensions, p_dimensions, v_actor, btrim(p_reason))
  RETURNING id INTO v_log_id;

  -- Transaction-local GUC → the carve-out admits exactly this UPDATE.
  PERFORM set_config('gnubok.allow_dimension_retag', 'true', true);

  -- PR9: write the bag only — cost_center/project are GENERATED and
  -- recompute from the bag in the same statement.
  UPDATE public.journal_entry_lines
     SET dimensions = p_dimensions
   WHERE id = p_line_id;

  RETURN jsonb_build_object(
    'changed', true,
    'log_id', v_log_id,
    'old_dimensions', v_line.dimensions,
    'new_dimensions', p_dimensions
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.retag_line_dimensions(uuid, uuid, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retag_line_dimensions(uuid, uuid, jsonb, text, uuid) TO authenticated, service_role;

-- ── 3. bulk_book_transactions: stop inserting the mirror columns ──────────
-- Body byte-identical to 20260702201000 except the journal_entry_lines
-- INSERT no longer names cost_center/project (generated). Bag normalization
-- stays. SET search_path + grants restated.
CREATE OR REPLACE FUNCTION public.bulk_book_transactions(
  p_tx_ids uuid[],
  p_existing_journal_entry_id uuid,
  p_new_entry jsonb,
  p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tx RECORD;
  v_tx_date date;
  v_total_amount numeric := 0;
  v_total_amount_abs numeric;
  v_direction text;
  v_tx_count int := 0;

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
  v_caller uuid := auth.uid();
BEGIN
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

  v_total_amount_abs := ABS(v_total_amount);

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
      AND length(account_number) = 4
      AND account_number BETWEEN '1900' AND '1999';

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
      IF length(v_line_account) = 4 AND v_line_account BETWEEN '1900' AND '1999' THEN
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
       entry_date, description, source_type, status)
    VALUES
      (v_journal_entry_id, v_caller, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
       v_tx_date, v_entry_description, 'manual', 'draft');

    v_sort_order := 0;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_entry->'lines')
    LOOP
      v_line_account := v_line->>'account_number';
      v_line_debit := COALESCE((v_line->>'debit_amount')::numeric, 0);
      v_line_credit := COALESCE((v_line->>'credit_amount')::numeric, 0);
      v_line_currency := COALESCE(v_line->>'currency', 'SEK');

      -- Bag normalization as before (DimensionsBagSchema parity). PR9: the
      -- generated mirrors derive from the stored bag — no explicit columns.
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

    SELECT voucher_number INTO v_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_journal_entry_id);

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
$$;

COMMENT ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid) IS
  'Bulk-book N bank transactions sharing the same date into a single combined verifikat (samlingsverifikation per BFL 5 kap 6§). Dimensions PR9: lines write the dimensions bag only — cost_center/project are GENERATED columns derived from keys 1/6.';

REVOKE ALL ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
