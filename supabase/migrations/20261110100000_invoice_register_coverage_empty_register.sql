-- get_invoice_register_coverage: an empty register is probed too (crm#1759).
--
-- Why: 20261023094000_invoice_register_coverage_rpc.sql answered an empty
-- register (no non-draft invoice with document_type 'invoice') with
-- covers_from NULL and has_pre_register_invoices false before looking at the
-- books, on the reasoning that the empty state routes the user to migration.
-- After an SIE migration the register is empty while the customer invoices
-- live as imported verifikat on 1510/1513, and every surface that gates its
-- disclosure on has_pre_register_invoices said nothing: an agent read an
-- empty gnubok_list_invoices as "no invoices".
--
-- What changes: the early return is gone. An empty register is complete from
-- no date yet, the same reading as a register holding only invoices
-- registered from the books, so its boundary is p_today and the probe asks
-- whether a posted verifikat from outside the invoice engine with an AR debit
-- line exists before it. Everything else is the function as it was.
--
-- Before and after: lib/reports/invoice-register-coverage.ts reads a null
-- covers_from as unknown, so code merged ahead of this migration keeps the
-- old answer until it lands, then shows the disclosure.
--
-- SECURITY INVOKER: RLS scopes every read to the caller, and every read also
-- filters on p_company_id.

CREATE OR REPLACE FUNCTION public.get_invoice_register_coverage(
  p_company_id uuid,
  p_ar_accounts text[],
  p_engine_source_types text[],
  p_today date,
  p_fiscal_period_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
DECLARE
  v_covers_from date;
  v_has_pre boolean := false;
  v_in_period boolean := false;
BEGIN
  -- Walk the register by date and stop at the first invoice not registered
  -- from the books, so the line check runs for a handful of invoices instead
  -- of all of them (OFFSET 0 keeps it out of the sorted scan). No such
  -- invoice, or none at all: complete from no date yet, so the boundary is
  -- p_today.
  SELECT d.invoice_date INTO v_covers_from
  FROM (
    SELECT i.id, i.invoice_date, i.journal_entry_id
    FROM public.invoices i
    WHERE i.company_id = p_company_id
      AND i.status <> 'draft'
      AND i.document_type = 'invoice'
    ORDER BY i.invoice_date
    OFFSET 0
  ) d
  WHERE d.journal_entry_id IS NULL
     OR EXISTS (SELECT 1 FROM public.invoice_items it WHERE it.invoice_id = d.id)
  LIMIT 1;

  v_covers_from := coalesce(v_covers_from, p_today);

  SELECT EXISTS (
    SELECT 1
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.status = 'posted'
      AND e.entry_date < v_covers_from
      AND NOT (e.source_type = ANY (p_engine_source_types))
      AND EXISTS (
        SELECT 1
        FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (p_ar_accounts)
          AND l.debit_amount > 0
      )
  ) INTO v_has_pre;

  IF v_has_pre AND p_fiscal_period_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.journal_entries e
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status = 'posted'
        AND e.entry_date < v_covers_from
        AND NOT (e.source_type = ANY (p_engine_source_types))
        AND EXISTS (
          SELECT 1
          FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = e.id
            AND l.account_number = ANY (p_ar_accounts)
            AND l.debit_amount > 0
        )
    ) INTO v_in_period;
  END IF;

  RETURN json_build_object(
    'covers_from', v_covers_from,
    'has_pre_register_invoices', v_has_pre,
    'pre_register_in_period', v_in_period
  );
END;
$$;

COMMENT ON FUNCTION public.get_invoice_register_coverage(uuid, text[], text[], date, uuid) IS
  'Coverage of the invoice register: where register-backed answers start being complete (p_today for an empty register or one of registrations only), and whether posted non-engine AR debits exist before that date (company-wide and in one fiscal period). SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.get_invoice_register_coverage(uuid, text[], text[], date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_register_coverage(uuid, text[], text[], date, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
