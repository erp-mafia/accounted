-- Customer-invoice hänvisning in the missing-underlag predicate (#2298).
--
-- BFL 5 kap 7 §: a verifikation may satisfy the underlag requirement by
-- hänvisning till underlag. Both RPCs below already accept a SUPPLIER invoice
-- reference (an anchored retained document reachable through
-- supplier_invoices / supplier_invoice_payments). The CUSTOMER side was
-- missing: an entry that a register invoice points at is backed by that
-- invoice, which Accounted itself issued and retains (BFL 7 kap), and whose
-- payment record identifies the inbetalning.
--
-- The link between a customer invoice and its verifikat is written on the
-- invoice side only: invoices.journal_entry_id for the registration booking
-- and invoice_payments.journal_entry_id for a kontantmetod inbetalning, a
-- delbetalning, or "matcha mot befintligt verifikat" (link_invoice_to_voucher).
-- The entry keeps its own source_type/source_id (a posted entry is immutable,
-- and "this came from a SIE import" is an audit fact). So a SIE-imported or
-- manual verifikat that a register invoice was matched to afterwards kept
-- surfacing as "Underlag saknas" even though the verifikat detail page already
-- listed the invoice as its underlag (journal-entry-references.ts). The
-- engine's own invoice source types (invoice_created, invoice_paid,
-- invoice_cash_payment, credit_note) are exempt by omission from the needs-doc
-- list; a linked entry is the same affärshändelse booked before migration and
-- gets the same treatment through the link.
--
-- Bodies identical to 20260825160000 (verifikat_without_documents) and
-- 20260823001000 (transactions_without_documents) except for the two added
-- NOT EXISTS arms. Same signatures: CREATE OR REPLACE keeps the grants; they
-- are restated for clarity. The transactions surface must stay a strict
-- subset of the verifikat surface, so both get the arms.
--
-- Keep the needs-doc list in lockstep with NEEDS_DOC_SOURCE_TYPES
-- (lib/worklist/types.ts); the customer arm has TS mirrors in
-- lib/core/bookkeeping/journal-entry-references.ts
-- (getInvoiceReferencesForJournalEntries) used by lib/bookkeeping/
-- missing-underlag.ts, /api/documents/counts and the transactions list.
--
-- pg-test: tests/pg/underlag-customer-invoice-reference.pg.test.ts
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
      -- Mirrors NEEDS_DOC_SOURCE_TYPES (lib/worklist/types.ts).
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
      -- BFL 5 kap 7 § hänvisning, customer side (#2298): an entry a register
      -- invoice points at is backed by that invoice. The invoice Accounted
      -- issued IS the verifikation for the sale, and the payment row
      -- identifies the inbetalning. Both links are written on the invoice
      -- side (registration booking, kontantmetod inbetalning, delbetalning,
      -- "matcha mot befintligt verifikat"), so an imported or manual entry
      -- keeps its own source_type and must be resolved from here. Tenant
      -- scoped on the link row, never on the entry alone.
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.company_id = p_company_id
          AND i.journal_entry_id = je.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoice_payments ip
        WHERE ip.company_id = p_company_id
          AND ip.journal_entry_id = je.id
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
      t.journal_entry_id,
      t.cash_account_id,
      ca.ledger_account AS cash_account_ledger
    FROM transactions t
    JOIN journal_entries je ON je.id = t.journal_entry_id
    LEFT JOIN cash_accounts ca
      ON ca.id = t.cash_account_id
     AND ca.company_id = t.company_id
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
      -- Customer-invoice hänvisning (#2298); see verifikat_without_documents.
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.company_id = p_company_id
          AND i.journal_entry_id = je.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoice_payments ip
        WHERE ip.company_id = p_company_id
          AND ip.journal_entry_id = je.id
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
           'journal_entry_id', p.journal_entry_id,
           'cash_account_id', p.cash_account_id,
           'cash_account_ledger', p.cash_account_ledger
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

NOTIFY pgrst, 'reload schema';
