-- SIE import: keep the source system's correction history (#2427).
--
-- SIE 4B carries a corrected voucher as three record types: #TRANS (final
-- state), #BTRANS (a line struck after posting) and #RTRANS (a line added by
-- a rättelse, always twinned by an identical #TRANS). The parser has booked
-- #TRANS only since #63 (summing all three double-counted), and dropped the
-- other two, so a migrated verifikat lost the trail of what was corrected.
--
-- This migration keeps that trail in journal_entry_rattelse_log, the table
-- the inline rättelse flow already writes and every reader (verifikat page,
-- rattelse-flags "Rättad" marker, behandlingshistorik, full archive) already
-- renders:
--
--   1. Three nullable/defaulted columns tell an imported history row apart
--      from a rättelse made here: source ('user' | 'sie_import'),
--      sie_import_id (the file it came from) and external_signature (the
--      SIE `sign` field: who removed/added the row in the source system;
--      SIE carries who, never when). actor stays NULL for imported rows.
--   2. import_sie_journal_entries writes one 'lines' log row per voucher
--      that carried #BTRANS/#RTRANS, inside the same atomic transaction as
--      the voucher itself. The ledger insert is untouched: lines still come
--      from #TRANS only, so balances and voucher numbering are unchanged.
--
-- Existing rows and existing imports are untouched (no backfill). Import
-- history rows survive undo/replace like every other log row (the table has
-- no FK to journal_entries on purpose: behandlingshistorik must not vanish
-- with its subject).
--
-- Function body below is the 20260712150000 text verbatim plus the
-- correction block; the statement_timeout from 20260721144311 is carried in
-- the header because CREATE OR REPLACE resets function configuration.
--
-- pg-test: lib/import/__tests__/sie-import-atomic.pg.test.ts

-- =============================================================================
-- 1. journal_entry_rattelse_log: provenance columns
-- =============================================================================

ALTER TABLE public.journal_entry_rattelse_log
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS sie_import_id uuid,
  ADD COLUMN IF NOT EXISTS external_signature text;

ALTER TABLE public.journal_entry_rattelse_log
  DROP CONSTRAINT IF EXISTS journal_entry_rattelse_log_source_check;
ALTER TABLE public.journal_entry_rattelse_log
  ADD CONSTRAINT journal_entry_rattelse_log_source_check
  CHECK (source IN ('user', 'sie_import'));

-- Imported rows carry no actor; a user rättelse always does (the RPCs
-- resolve it before writing). Keeps the two provenances honest.
ALTER TABLE public.journal_entry_rattelse_log
  DROP CONSTRAINT IF EXISTS journal_entry_rattelse_log_import_provenance_check;
ALTER TABLE public.journal_entry_rattelse_log
  ADD CONSTRAINT journal_entry_rattelse_log_import_provenance_check
  CHECK (
    (source = 'sie_import' AND actor IS NULL)
    OR (source = 'user' AND sie_import_id IS NULL AND external_signature IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_journal_entry_rattelse_log_sie_import
  ON public.journal_entry_rattelse_log (company_id, sie_import_id)
  WHERE sie_import_id IS NOT NULL;

COMMENT ON COLUMN public.journal_entry_rattelse_log.source IS
  'user: rättelse made in Accounted (actor set). sie_import: correction history carried by the imported SIE file (#BTRANS/#RTRANS), actor NULL.';
COMMENT ON COLUMN public.journal_entry_rattelse_log.sie_import_id IS
  'sie_imports.id of the file that carried this history row (source = sie_import). No FK: the log outlives undo/replace.';
COMMENT ON COLUMN public.journal_entry_rattelse_log.external_signature IS
  'SIE sign field on the #BTRANS/#RTRANS rows: who removed/added the line in the source system. Free text, never a user id.';

-- =============================================================================
-- 2. Snapshot builder: SIE correction rows in the inline-rättelse snapshot shape
-- =============================================================================
-- correct_entry_lines_inline stores to_jsonb(journal_entry_lines) rows. The
-- verifikat page keys on id and interleaves on sort_order, so imported rows
-- get a fresh id and the same field set. Amounts are what the caller sends
-- (already rounded to öre by the importer); currency is the import's SEK.
-- VOLATILE because of gen_random_uuid().

CREATE OR REPLACE FUNCTION public.sie_correction_snapshots(
  p_entry_id uuid,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', gen_random_uuid(),
        'journal_entry_id', p_entry_id,
        'account_number', btrim(r.value->>'account_number'),
        'debit_amount', round(COALESCE((r.value->>'debit_amount')::numeric, 0), 2),
        'credit_amount', round(COALESCE((r.value->>'credit_amount')::numeric, 0), 2),
        'currency', 'SEK',
        'line_description', NULLIF(btrim(COALESCE(r.value->>'line_description', '')), ''),
        'sort_order', COALESCE((r.value->>'sort_order')::integer, r.ord::integer - 1)
      )
      ORDER BY r.ord
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, ord)
  WHERE jsonb_typeof(r.value) = 'object';
$$;

REVOKE ALL ON FUNCTION public.sie_correction_snapshots(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sie_correction_snapshots(uuid, jsonb) TO authenticated, service_role;

-- =============================================================================
-- 3. import_sie_journal_entries: write the history row per corrected voucher
-- =============================================================================

CREATE OR REPLACE FUNCTION public.import_sie_journal_entries(
  p_company_id uuid,
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_entries jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '290s'
AS $$
DECLARE
  v_entry jsonb;
  v_line jsonb;
  v_series text;
  v_count integer;
  v_new_last integer;
  v_start integer;
  v_assigned_number integer;
  v_entry_id uuid;
  v_deb numeric;
  v_cred numeric;
  v_inserted jsonb := '[]'::jsonb;
  v_corrections jsonb;
  v_struck jsonb;
  v_added jsonb;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'p_entries must be a JSON array';
  END IF;

  -- Tenant guard: anon/authenticated may only import into their own companies;
  -- service_role / direct access (no JWT role) bypasses for migrations and
  -- server-side maintenance paths that scope company access before calling.
  -- NULL-safe predicate (a NULL company resolves to false) per #881.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF v_jwt_role IN ('anon', 'authenticated')
     AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must match auth.uid()'
      USING ERRCODE = '42501';
  END IF;

  -- The fiscal period must belong to the target company: a caller could
  -- otherwise post into another company's period id (defense in depth; the
  -- header company_id/FK would still scope the rows, but fail closed here).
  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods
    WHERE id = p_fiscal_period_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'fiscal period % does not belong to company %', p_fiscal_period_id, p_company_id
      USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.sie_import_series_numbers (
    series text PRIMARY KEY,
    next_number integer NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.sie_import_series_numbers;

  FOR v_series, v_count IN
    SELECT COALESCE(NULLIF(e.value->>'series', ''), 'A') AS series, count(*)::integer AS count
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
    GROUP BY COALESCE(NULLIF(e.value->>'series', ''), 'A')
    ORDER BY min(e.ord)
  LOOP
    INSERT INTO public.voucher_sequences
      (company_id, user_id, fiscal_period_id, voucher_series, last_number)
    VALUES
      (p_company_id, p_user_id, p_fiscal_period_id, v_series, v_count)
    ON CONFLICT (company_id, fiscal_period_id, voucher_series)
    DO UPDATE SET
      last_number = public.voucher_sequences.last_number + EXCLUDED.last_number,
      updated_at = now()
    RETURNING last_number INTO v_new_last;

    v_start := v_new_last - v_count + 1;

    INSERT INTO pg_temp.sie_import_series_numbers(series, next_number)
    VALUES (v_series, v_start);
  END LOOP;

  FOR v_entry IN
    SELECT e.value
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
    ORDER BY e.ord
  LOOP
    v_series := COALESCE(NULLIF(v_entry->>'series', ''), 'A');

    SELECT next_number
    INTO v_assigned_number
    FROM pg_temp.sie_import_series_numbers
    WHERE series = v_series
    FOR UPDATE;

    UPDATE pg_temp.sie_import_series_numbers
    SET next_number = next_number + 1
    WHERE series = v_series;

    INSERT INTO public.journal_entries (
      user_id,
      company_id,
      fiscal_period_id,
      voucher_number,
      voucher_series,
      entry_date,
      description,
      source_type,
      source_voucher_series,
      source_voucher_number,
      status
    )
    VALUES (
      p_user_id,
      p_company_id,
      p_fiscal_period_id,
      v_assigned_number,
      v_series,
      (v_entry->>'date')::date,
      v_entry->>'description',
      COALESCE(NULLIF(v_entry->>'sourceType', ''), 'import'),
      NULLIF(v_entry->>'sourceSeries', ''),
      CASE
        WHEN v_entry ? 'sourceNumber' AND v_entry->>'sourceNumber' IS NOT NULL
        THEN (v_entry->>'sourceNumber')::integer
        ELSE NULL
      END,
      'draft'
    )
    RETURNING id INTO v_entry_id;

    IF jsonb_typeof(v_entry->'lines') <> 'array' OR jsonb_array_length(v_entry->'lines') = 0 THEN
      RAISE EXCEPTION 'SIE journal entry % has no lines', COALESCE(v_entry->>'sourceId', '<unknown>');
    END IF;

    FOR v_line IN
      SELECT l.value
      FROM jsonb_array_elements(v_entry->'lines') WITH ORDINALITY AS l(value, ord)
      ORDER BY l.ord
    LOOP
      INSERT INTO public.journal_entry_lines (
        journal_entry_id,
        account_number,
        account_id,
        debit_amount,
        credit_amount,
        currency,
        line_description,
        sort_order,
        dimensions
      )
      VALUES (
        v_entry_id,
        v_line->>'account_number',
        CASE
          WHEN v_line ? 'account_id' AND v_line->>'account_id' IS NOT NULL
          THEN (v_line->>'account_id')::uuid
          ELSE NULL
        END,
        COALESCE((v_line->>'debit_amount')::numeric, 0),
        COALESCE((v_line->>'credit_amount')::numeric, 0),
        COALESCE(NULLIF(v_line->>'currency', ''), 'SEK'),
        NULLIF(v_line->>'line_description', ''),
        COALESCE((v_line->>'sort_order')::integer, 0),
        COALESCE(v_line->'dimensions', '{}'::jsonb)
      );
    END LOOP;

    -- Per-voucher balance enforcement (hard rule #3). SECURITY DEFINER + the
    -- direct draft->posted UPDATE below bypass the trigger path, so assert
    -- balance here; a RAISE rolls the whole atomic import back.
    SELECT COALESCE(sum(debit_amount), 0), COALESCE(sum(credit_amount), 0)
    INTO v_deb, v_cred
    FROM public.journal_entry_lines
    WHERE journal_entry_id = v_entry_id;

    IF round(v_deb, 2) <> round(v_cred, 2) OR round(v_deb, 2) <= 0 THEN
      RAISE EXCEPTION 'SIE journal entry % is unbalanced (debit %, credit %)',
        COALESCE(v_entry->>'sourceId', '<unknown>'), v_deb, v_cred;
    END IF;

    UPDATE public.journal_entries
    SET status = 'posted',
        committed_at = now()
    WHERE id = v_entry_id
      AND company_id = p_company_id;

    -- Source-system correction history (#2427). The SIE file's #BTRANS
    -- (struck) and #RTRANS (added) rows for this voucher land as ONE
    -- rättelselogg row with source='sie_import': the same snapshot shape
    -- correct_entry_lines_inline writes, so the verifikat page and
    -- behandlingshistoriken render it unchanged. Never booked as lines; the
    -- ledger above is built from #TRANS only.
    v_corrections := v_entry->'corrections';
    IF jsonb_typeof(v_corrections) = 'object' THEN
      v_struck := CASE WHEN jsonb_typeof(v_corrections->'struck') = 'array'
                       THEN v_corrections->'struck' ELSE '[]'::jsonb END;
      v_added  := CASE WHEN jsonb_typeof(v_corrections->'added') = 'array'
                       THEN v_corrections->'added' ELSE '[]'::jsonb END;

      IF jsonb_array_length(v_struck) > 0 OR jsonb_array_length(v_added) > 0 THEN
        INSERT INTO public.journal_entry_rattelse_log (
          company_id,
          journal_entry_id,
          rattelse_type,
          struck_lines,
          added_lines,
          actor,
          source,
          sie_import_id,
          external_signature
        )
        VALUES (
          p_company_id,
          v_entry_id,
          'lines',
          public.sie_correction_snapshots(v_entry_id, v_struck),
          public.sie_correction_snapshots(v_entry_id, v_added),
          NULL,
          'sie_import',
          CASE
            WHEN v_entry ? 'sieImportId' AND NULLIF(v_entry->>'sieImportId', '') IS NOT NULL
            THEN (v_entry->>'sieImportId')::uuid
            ELSE NULL
          END,
          NULLIF(btrim(COALESCE(v_corrections->>'signature', '')), '')
        );
      END IF;
    END IF;

    v_inserted := v_inserted || jsonb_build_array(jsonb_build_object(
      'id', v_entry_id,
      'sourceId', v_entry->>'sourceId',
      'series', v_series,
      'voucherNumber', v_assigned_number,
      'sourceType', COALESCE(NULLIF(v_entry->>'sourceType', ''), 'import')
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'inserted_entries', v_inserted,
    'skipped_duplicates', '[]'::jsonb,
    'validation_errors', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_sie_journal_entries(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_sie_journal_entries(uuid, uuid, uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
