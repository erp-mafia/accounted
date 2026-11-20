-- get_invoice_register_coverage: the invoice register's coverage boundary
-- and the pre-register AR probe in one call (lib/reports/invoice-register-coverage.ts).
--
-- Why: fetchInvoiceRegisterCoverage read the register's earliest invoice as
-- `invoice_date, journal_entry_id, invoice_items(id) ORDER BY invoice_date
-- LIMIT 1`. PostgREST builds the invoice_items embed for every invoice of the
-- company before the LIMIT applies, each under invoice_items' RLS policy (a
-- lookup of the parent invoice per item): ~125 ms for 16 800 invoices, and
-- the kundreskontra ran it twice (the ledger's disclosure and the 1510
-- reconciliation's in-period check).
--
-- What it answers, the same as the TypeScript did:
--   covers_from: null when the register (non-draft invoices with
--     document_type 'invoice') is empty; otherwise the earliest invoice_date
--     of a register invoice that is not registered from the books (one that
--     is unlinked, or has lines), and p_today when every one of them is. The
--     TypeScript took the register's earliest invoice and, when that one was
--     registered from the books, the earliest such invoice instead: the same
--     date in every case, ties on the earliest date included.
--   has_pre_register_invoices: a posted verifikat from outside the invoice
--     engine (source_type not in p_engine_source_types) dated before
--     covers_from has a debit line on one of p_ar_accounts.
--   pre_register_in_period: the same probe inside p_fiscal_period_id, asked
--     only when the company-wide probe found one and a period is given.
-- The account roles and the engine's source types stay defined in
-- TypeScript and are passed in.
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
  IF NOT EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.company_id = p_company_id
      AND i.status <> 'draft'
      AND i.document_type = 'invoice'
  ) THEN
    RETURN json_build_object(
      'covers_from', NULL,
      'has_pre_register_invoices', false,
      'pre_register_in_period', false
    );
  END IF;

  -- Walk the register by date and stop at the first invoice not registered
  -- from the books, so the line check runs for a handful of invoices instead
  -- of all of them (OFFSET 0 keeps it out of the sorted scan).
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
  'Coverage of the invoice register: where register-backed answers start being complete, and whether posted non-engine AR debits exist before that date (company-wide and in one fiscal period). SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.get_invoice_register_coverage(uuid, text[], text[], date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_register_coverage(uuid, text[], text[], date, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
