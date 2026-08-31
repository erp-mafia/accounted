-- Migration: transactions_without_documents exposes the bank account
--
-- Customer report (A4): neither MCP transaction listing nor v1 REST says
-- which bank account a transaction belongs to, so per-account reconciliation
-- cannot be done from outside. The predicate, ordering and paging of this
-- RPC are unchanged; every row now also carries cash_account_id and the
-- cash account's BAS ledger (cash_account_ledger), LEFT JOINed so rows
-- without a backfilled cash_account_id still appear with nulls.
--
-- Same signature as 20260724090000 (uuid, date, integer, integer): CREATE OR
-- REPLACE keeps the existing grants; they are restated for clarity.

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
