-- Unify the missing-document surfaces on ONE truth (mcp_optimization_plan
-- P1-3).
--
-- Before this migration the two MCP surfaces disagreed:
--   - gnubok_list_transactions_without_documents keyed on
--     transactions.document_id
--   - gnubok_list_verifikat_without_documents keyed on document_attachments
--     rows — and ignored source-type semantics, version chains and the
--     journal_entry_no_doc_required waiver table that lib/worklist's
--     canonical count respects.
-- Measured divergence on prod (2026-07-03): 22,046 waived verifikat still
-- listed to agents, 2,370 doc-exempt source types listed, ~87 bank
-- transactions whose attached doc was never propagated to the verifikat
-- (all in open periods), and 1,100 transactions listed as missing receipts
-- although their verifikat HAS the underlag.
--
-- After: both RPCs implement the same predicate — a posted journal entry of a
-- needs-doc source type, with no CURRENT-version document_attachments row and
-- no journal_entry_no_doc_required waiver. The transactions surface is the
-- bank-driven SUBSET of the verifikat surface by construction (it joins the
-- same predicate through transactions.journal_entry_id).
--
-- The needs-doc source-type list mirrors NEEDS_DOC_SOURCE_TYPES in
-- lib/worklist/categories.ts — keep them in lockstep (pinned by
-- tests/pg/document-surfaces-unification.pg.test.ts, which imports the TS
-- constant and probes the RPC per source type).
--
-- pg-test: tests/pg/document-surfaces-unification.pg.test.ts

-- ────────────────────────────────────────────────────────────────────
-- 1. Verifikat surface: canonical predicate
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.verifikat_without_documents(
  p_company_id uuid,
  p_since date DEFAULT NULL,
  p_min_amount numeric DEFAULT 0,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_min numeric := greatest(coalesce(p_min_amount, 0), 0);
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN');
    END IF;
  END IF;

  WITH candidates AS (
    SELECT
      je.id,
      je.voucher_series,
      je.voucher_number,
      je.entry_date,
      je.description,
      je.source_type,
      round(coalesce(sum(l.debit_amount), 0), 2) AS gross_amount
    FROM journal_entries je
    LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      -- Only source types whose affärshändelse requires an underlag.
      -- Mirrors NEEDS_DOC_SOURCE_TYPES (lib/worklist/categories.ts).
      AND je.source_type IN (
        'manual',
        'bank_transaction',
        'supplier_invoice_registered',
        'supplier_invoice_paid',
        'supplier_invoice_cash_payment',
        'import'
      )
      -- Superseded document versions do not satisfy BFL underlag.
      AND NOT EXISTS (
        SELECT 1 FROM document_attachments d
        WHERE d.journal_entry_id = je.id AND d.is_current_version = true
      )
      -- Explicitly waived (e.g. internal transfers) — user decided no
      -- underlag is required; do not resurface to agents.
      AND NOT EXISTS (
        SELECT 1 FROM journal_entry_no_doc_required x
        WHERE x.journal_entry_id = je.id
      )
      AND (p_since IS NULL OR je.entry_date >= p_since)
    GROUP BY je.id
    HAVING round(coalesce(sum(l.debit_amount), 0), 2) >= v_min
  ),
  total AS (
    SELECT count(*) AS n FROM candidates
  ),
  page AS (
    SELECT * FROM candidates
    ORDER BY entry_date DESC, voucher_number DESC, id DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'ok', true,
    'total_count', (SELECT n FROM total),
    'verifikat', coalesce(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'journal_entry_id', p.id,
           'voucher_series', p.voucher_series,
           'voucher_number', p.voucher_number,
           'entry_date', p.entry_date,
           'description', p.description,
           'source_type', p.source_type,
           'gross_amount', p.gross_amount
         )
         ORDER BY p.entry_date DESC, p.voucher_number DESC, p.id DESC
       ) FROM page p),
      '[]'::jsonb
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

-- CREATE OR REPLACE preserves the grants from 20260703130000 (verified on
-- prod: authenticated + service_role only). Restated explicitly so this
-- migration is self-contained and safe even standalone.
REVOKE ALL ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────
-- 2. Transactions surface: the bank-driven subset of the same predicate
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transactions_without_documents(
  p_company_id uuid,
  p_since date DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TRANSACTIONS_WITHOUT_DOCUMENTS_FORBIDDEN');
    END IF;
  END IF;

  WITH candidates AS (
    SELECT
      t.id,
      t.date,
      t.description,
      t.amount,
      t.currency,
      t.merchant_name,
      t.reference,
      t.is_business,
      t.category,
      t.journal_entry_id
    FROM transactions t
    JOIN journal_entries je ON je.id = t.journal_entry_id
    WHERE t.company_id = p_company_id
      AND je.status = 'posted'
      -- Same predicate as verifikat_without_documents — this surface is the
      -- bank-driven subset, keyed on the SAME document truth
      -- (document_attachments), never transactions.document_id.
      AND je.source_type IN (
        'manual',
        'bank_transaction',
        'supplier_invoice_registered',
        'supplier_invoice_paid',
        'supplier_invoice_cash_payment',
        'import'
      )
      AND NOT EXISTS (
        SELECT 1 FROM document_attachments d
        WHERE d.journal_entry_id = je.id AND d.is_current_version = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM journal_entry_no_doc_required x
        WHERE x.journal_entry_id = je.id
      )
      AND (p_since IS NULL OR t.date >= p_since)
  ),
  total AS (
    SELECT count(*) AS n FROM candidates
  ),
  page AS (
    SELECT * FROM candidates
    ORDER BY date DESC, id DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'ok', true,
    'total_count', (SELECT n FROM total),
    'transactions', coalesce(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'id', p.id,
           'transaction_id', p.id,
           'date', p.date,
           'description', p.description,
           'amount', p.amount,
           'currency', p.currency,
           'merchant_name', p.merchant_name,
           'reference', p.reference,
           'is_business', p.is_business,
           'category', p.category,
           'journal_entry_id', p.journal_entry_id
         )
         ORDER BY p.date DESC, p.id DESC
       ) FROM page p),
      '[]'::jsonb
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.transactions_without_documents(uuid, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transactions_without_documents(uuid, date, integer, integer) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────
-- 3. Backfill the historical propagation gap: docs attached to a booked
--    transaction whose verifikat never received the document_attachments
--    link. Only docs that are currently unlinked (never steal a doc that
--    points at another verifikat) and only into open, unlocked periods
--    (the enforce_period_lock trigger raises on journal_entry_id writes in
--    locked/closed periods). ~87 rows on prod, all in open periods.
-- ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_updated integer;
BEGIN
  WITH gap AS (
    SELECT t.document_id, t.journal_entry_id
    FROM transactions t
    JOIN journal_entries je ON je.id = t.journal_entry_id
    JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
    WHERE t.document_id IS NOT NULL
      AND je.status = 'posted'
      AND fp.is_closed = false
      AND fp.locked_at IS NULL
  )
  UPDATE document_attachments d
  SET journal_entry_id = gap.journal_entry_id
  FROM gap
  WHERE d.id = gap.document_id
    AND d.journal_entry_id IS NULL
    AND d.is_current_version = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'document_surfaces_unification: propagated % transaction-attached documents to their verifikat', v_updated;
END;
$$;

NOTIFY pgrst, 'reload schema';
