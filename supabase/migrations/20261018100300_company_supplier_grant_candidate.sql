-- Grants, slice 2: the grant suggestion for a supplier's invoices.
-- "Godkänn <leverantör> automatiskt nästa gång, upp till X kr?"
--
-- company_supplier_grant_candidate(company, supplier, min_count): the input
-- of the grant-suggestion detector for supplier invoices
-- (src/lib/suggestions/detectors/grant-candidate.ts, behind
-- GRANT_SUGGESTIONS, default off), by the same rules as the bank-line
-- candidate (company_grant_candidate, 20261017100500). For the supplier of
-- the invoice just registered, it reads the company's latest min_count
-- staged supplier invoices from the inbox for that supplier that a person
-- approved (committed create_supplier_invoice_from_inbox operations, never
-- one a grant let through) whose inbox item became a supplier invoice whose
-- registration verifikat is still posted (committed after the operation was
-- staged) and which was never credited or reversed. It answers a candidate only when all of them carry
-- the identical booking pattern (supplier_invoice_operation_pattern without
-- the amount and the date, plus the accounts the verifikat touched), none
-- asked for anything a grant never covers (supplier_invoice_operation_unfit),
-- every line is on an account a grant may book (grant_item_account_allowed),
-- the verifikat touched every line account and 2440 credited the invoice
-- total, the company books invoices when they are registered, the supplier
-- has no active grant and grants are not paused. The evidence (how many, the
-- largest total, the last invoice date) rides along for the proposal and the
-- grant's evidence column. service_role only.
--
-- pg-test: tests/pg/company-grants-supplier-invoices.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

CREATE FUNCTION public.company_supplier_grant_candidate(
  p_company_id uuid,
  p_supplier_id uuid,
  p_min_count integer DEFAULT 5,
  p_window_months integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier public.suppliers;
  v_settings public.company_settings;
  v_count integer;
  v_distinct integer;
  v_unfit integer;
  v_pattern jsonb;
  v_max numeric;
  v_last date;
  v_min integer := greatest(coalesce(p_min_count, 5), 2);
BEGIN
  SELECT * INTO v_supplier FROM public.suppliers WHERE id = p_supplier_id AND company_id = p_company_id;
  IF v_supplier.id IS NULL THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'supplier_not_found');
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_grant_settings s WHERE s.company_id = p_company_id AND s.paused) THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'paused');
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_grants g
              WHERE g.company_id = p_company_id AND g.operation_type = 'create_supplier_invoice_from_inbox'
                AND g.counterparty_key = 'supplier:' || p_supplier_id::text AND g.revoked_at IS NULL) THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'has_grant');
  END IF;
  SELECT * INTO v_settings FROM public.company_settings WHERE company_id = p_company_id;
  IF coalesce(v_settings.accounting_method, 'accrual') <> 'accrual' OR coalesce(v_settings.defer_invoice_booking, false) THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'registration_not_booked');
  END IF;

  WITH booked AS (
    SELECT po.params, po.preview_data, po.created_at,
           public.supplier_invoice_operation_pattern(po.params, po.preview_data, v_supplier.supplier_type) AS pattern,
           public.supplier_invoice_operation_unfit(po.params, po.preview_data) AS unfit,
           (SELECT array_agg(DISTINCT l.account_number ORDER BY l.account_number)
              FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id) AS posted_accounts,
           (SELECT sum(l.credit_amount - l.debit_amount)
              FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id AND l.account_number = '2440') AS posted_payable
      FROM public.pending_operations po
      -- Through the inbox item, not result_data: the executor links the item
      -- before it emits supplier_invoice.registered, while result_data is
      -- written only when the commit finalizes, after the detector ran, so
      -- the approval that fired the event counts itself.
      JOIN public.invoice_inbox_items ii
        ON ii.id = CASE WHEN po.params->>'inbox_item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (po.params->>'inbox_item_id')::uuid END
       AND ii.company_id = p_company_id
      JOIN public.supplier_invoices si
        ON si.id = ii.created_supplier_invoice_id
       AND si.company_id = p_company_id
       AND si.supplier_id = p_supplier_id
       AND si.status NOT IN ('credited', 'reversed')
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoices cn
                        WHERE cn.credited_invoice_id = si.id AND cn.is_credit_note AND cn.status <> 'reversed')
      JOIN public.journal_entries je
        ON je.id = si.registration_journal_entry_id AND je.status = 'posted' AND je.committed_at >= po.created_at
     WHERE po.company_id = p_company_id
       AND po.operation_type = 'create_supplier_invoice_from_inbox'
       AND po.status IN ('committed', 'committing')
       AND po.params->>'supplier_id' = p_supplier_id::text
       AND po.created_at > now() - make_interval(months => greatest(coalesce(p_window_months, 12), 1))
       AND NOT EXISTS (SELECT 1 FROM public.company_grant_uses u WHERE u.pending_operation_id = po.id)
     ORDER BY po.created_at DESC
     LIMIT v_min
  ),
  judged AS (
    SELECT (b.pattern - 'amount_sek' - 'invoice_date' - 'supplier_id')
             || jsonb_build_object('line_accounts', to_jsonb(b.posted_accounts)) AS pattern,
           (b.pattern->>'amount_sek')::numeric AS amount_sek,
           (b.pattern->>'invoice_date')::date AS invoice_date,
           b.created_at,
           b.pattern IS NOT NULL
             AND b.unfit IS NULL
             AND b.posted_accounts IS NOT NULL
             AND '2440' = ANY (b.posted_accounts)
             AND cardinality(b.posted_accounts) <= 16
             AND jsonb_array_length(b.pattern->'item_lines') <= 12
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(b.pattern->'item_lines') AS l
                              WHERE NOT public.grant_item_account_allowed(split_part(l, ':', 1))
                                 OR NOT (split_part(l, ':', 1) = ANY (b.posted_accounts)))
             AND round(b.posted_payable, 2) = (b.pattern->>'amount_sek')::numeric AS fit
      FROM booked b
  )
  SELECT count(*), count(DISTINCT pattern), count(*) FILTER (WHERE NOT fit), max(amount_sek), max(invoice_date),
         (array_agg(pattern ORDER BY created_at DESC))[1]
    INTO v_count, v_distinct, v_unfit, v_max, v_last, v_pattern
    FROM judged;

  IF v_count < v_min THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'not_enough', 'booking_count', v_count);
  END IF;
  IF v_unfit > 0 OR v_distinct <> 1 THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'not_consistent', 'booking_count', v_count);
  END IF;

  RETURN jsonb_build_object(
    'candidate', true,
    'supplier_id', v_supplier.id,
    'counterparty_label', left(coalesce(nullif(btrim(v_supplier.name), ''), 'Leverantör'), 200),
    'pattern', v_pattern,
    'booking_count', v_count,
    'max_amount_sek', v_max,
    'last_booked', v_last
  );
END;
$$;

REVOKE ALL ON FUNCTION public.company_supplier_grant_candidate(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_supplier_grant_candidate(uuid, uuid, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
