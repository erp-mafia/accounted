-- Add 'webshop_order' to the needs-doc source-type list of
-- verifikat_without_documents (#1881).
--
-- Webshop order bookings now archive a generated orderunderlag (line items,
-- customer, payment method) on the verifikat at booking time. The source type
-- therefore belongs in the needs-doc list: a webshop_order verifikat without a
-- current-version document (historical bookings from before #1881, or a failed
-- underlag attach) must surface on the "saknar underlag" worklist instead of
-- silently passing as documented.
--
-- Only the verifikat surface changes. transactions_without_documents stays
-- as-is: webshop_order entries never hang on a transactions row (the legacy
-- feed cross-lock guarantees a feed row and an order row are never both
-- booked), so the transactions surface cannot contain them and remains a
-- strict subset of this one.
--
-- Body identical to 20260724090000 except for the added source type. Keep the
-- needs-doc list in lockstep with NEEDS_DOC_SOURCE_TYPES
-- (lib/worklist/categories.ts); pinned by
-- tests/pg/document-surfaces-unification.pg.test.ts.
--
-- pg-test: tests/pg/document-surfaces-unification.pg.test.ts

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
        'import',
        'webshop_order'
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

NOTIFY pgrst, 'reload schema';
