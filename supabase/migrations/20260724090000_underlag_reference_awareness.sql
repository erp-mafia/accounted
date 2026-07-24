-- Underlag reference awareness for the missing-document surfaces.
--
-- Problem (support case 2026-07-24): verifikat booked from supplier invoices
-- were flagged "saknar underlag" although the invoice's source document is
-- retained. Two flows produced the false positives:
--
--   1. Payment verifikat (supplier_invoice_paid): the invoice document
--      deliberately hangs on the REGISTRATION verifikat (one
--      document_attachments row can only point at one journal entry), so the
--      payment entry never has a direct doc row. BFL 5 kap 7 § allows a
--      verifikation to satisfy the underlag requirement by hänvisning till
--      underlag; the payment entry's FK reference to the supplier invoice
--      (whose document is archived under WORM) is exactly that. The UI's
--      reference resolver (lib/core/bookkeeping/journal-entry-references.ts)
--      already treats it as underlag; the RPCs did not, so the row-expand view
--      showed a document while the list warning persisted.
--
--   2. Documents pinned to a bank transaction before the transaction was
--      matched to a supplier invoice: the match routes did not propagate
--      transactions.document_id onto the created payment verifikat (the
--      categorize route does). Fixed in the routes in the same change; the
--      backfill below repairs rows already written.
--
-- The predicate: an entry is NOT missing underlag when a supplier invoice
-- referencing it (registration_journal_entry_id, payment_journal_entry_id, or
-- a supplier_invoice_payments row) carries a document that is ANCHORED to a
-- journal entry (document_attachments.journal_entry_id IS NOT NULL). The
-- anchor requirement is what makes the hänvisning legally safe: every
-- deletion guard (deleteDocument, block_document_deletion) keys on
-- journal_entry_id, so an unanchored doc is deletable and must NOT silence
-- the warning: the nag is the mechanism that gets it anchored. Anchored docs
-- are WORM-protected and the supersession RPC (create_document_version)
-- guarantees every retained chain has a readable current version. Customer
-- invoices carry no document_id and their source types are not in the
-- needs-doc list, so they stay out of the predicate.
--
-- Keep the needs-doc source-type list in lockstep with NEEDS_DOC_SOURCE_TYPES
-- (lib/worklist/categories.ts); pinned by
-- tests/pg/document-surfaces-unification.pg.test.ts.
--
-- pg-test: tests/pg/document-surfaces-unification.pg.test.ts

-- ────────────────────────────────────────────────────────────────────
-- 1. Verifikat surface
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
      -- Explicitly waived (e.g. internal transfers): user decided no
      -- underlag is required; do not resurface to agents.
      AND NOT EXISTS (
        SELECT 1 FROM journal_entry_no_doc_required x
        WHERE x.journal_entry_id = je.id
      )
      -- BFL 5 kap 7 §: hänvisning till underlag. An entry booked from a
      -- supplier invoice whose source document is retained is covered by
      -- that document even though the doc row hangs on the invoice's other
      -- verifikat (registration vs payment). The doc must be ANCHORED
      -- (journal_entry_id set): only anchored docs sit behind the WORM
      -- deletion guards, so an unanchored doc cannot legally back a posted
      -- verifikat and must keep the warning alive.
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoices si
        JOIN document_attachments sd ON sd.id = si.document_id
        WHERE si.company_id = p_company_id
          AND sd.journal_entry_id IS NOT NULL
          AND (si.registration_journal_entry_id = je.id
            OR si.payment_journal_entry_id = je.id)
      )
      -- Partial payments link through supplier_invoice_payments instead of
      -- supplier_invoices.payment_journal_entry_id.
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoice_payments sip
        JOIN supplier_invoices sip_si ON sip_si.id = sip.supplier_invoice_id
        JOIN document_attachments sipd ON sipd.id = sip_si.document_id
        WHERE sip.journal_entry_id = je.id
          AND sip_si.company_id = p_company_id
          AND sipd.journal_entry_id IS NOT NULL
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
      -- Same predicate as verifikat_without_documents: this surface is the
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
      -- BFL 5 kap 7 § hänvisning till underlag (anchored docs only); see
      -- verifikat_without_documents.
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoices si
        JOIN document_attachments sd ON sd.id = si.document_id
        WHERE si.company_id = p_company_id
          AND sd.journal_entry_id IS NOT NULL
          AND (si.registration_journal_entry_id = je.id
            OR si.payment_journal_entry_id = je.id)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoice_payments sip
        JOIN supplier_invoices sip_si ON sip_si.id = sip.supplier_invoice_id
        JOIN document_attachments sipd ON sipd.id = sip_si.document_id
        WHERE sip.journal_entry_id = je.id
          AND sip_si.company_id = p_company_id
          AND sipd.journal_entry_id IS NOT NULL
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
-- 3. Supporting indexes: the reference anti-joins probe supplier_invoices by
--    journal-entry FK and supplier_invoice_payments by journal_entry_id;
--    none of these carry an index by default. Partial on document_id so the
--    index only holds rows that can actually satisfy the predicate.
-- ────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_registration_je_doc
  ON public.supplier_invoices (registration_journal_entry_id)
  WHERE document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_payment_je_doc
  ON public.supplier_invoices (payment_journal_entry_id)
  WHERE document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_invoice_payments_journal_entry_id
  ON public.supplier_invoice_payments (journal_entry_id);

-- ────────────────────────────────────────────────────────────────────
-- 4. Backfill the match-flow propagation gap: docs pinned to a booked
--    transaction whose verifikat never received the document_attachments
--    link. Same shape as 20260703160000 §3 and idempotent alongside it:
--    only currently-unlinked docs (never steal a doc that points at another
--    verifikat) and only into open, unlocked periods (enforce_period_lock
--    raises on journal_entry_id writes in locked/closed periods).
-- ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_updated integer;
BEGIN
  WITH gap AS (
    SELECT t.document_id, t.journal_entry_id, t.company_id
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
    -- Tenancy guard (defense in depth; the attach routes enforce it
    -- app-side, but a corrupt cross-company pin must not be welded into an
    -- immutable underlag link here).
    AND d.company_id = gap.company_id
    AND d.journal_entry_id IS NULL
    AND d.is_current_version = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'underlag_reference_awareness: propagated % transaction-pinned documents to their verifikat', v_updated;
END;
$$;

NOTIFY pgrst, 'reload schema';
