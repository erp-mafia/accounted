-- accounted#166: hard blocks judge expense_claim drafts too. A dashboard
-- registration is a person's review; v1 stages the same pending operation MCP
-- already uses. Expense payouts and salary attachment settle the claim and
-- keep their existing source types, so they stay exempt.

SELECT set_config('lock_timeout', '5s', true);

CREATE OR REPLACE FUNCTION public.booking_review_entry_parties(p_company_id uuid, p_entry_id uuid)
RETURNS TABLE(kind text, counterparty_key text, amount_sek numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH entry AS (
    SELECT je.id, je.source_type, je.source_id, je.bank_booking_context
      FROM public.journal_entries je
     WHERE je.id = p_entry_id
       AND je.company_id = p_company_id
  )
  SELECT 'bank_row'::text,
         public.grant_counterparty_key(t.merchant_name, t.original_description, t.description),
         abs(coalesce(t.amount_sek, t.amount))
    FROM entry e
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.bank_booking_context, '[]'::jsonb)) AS c(item)
    JOIN public.transactions t
      ON t.id = (c.item->>'transaction_id')::uuid
     AND t.company_id = p_company_id
  UNION ALL
  SELECT 'supplier_invoice'::text,
         public.grant_counterparty_key(s.name, NULL, NULL),
         abs(coalesce(si.total_sek, si.total * coalesce(si.exchange_rate, 1)))
    FROM entry e
    JOIN public.supplier_invoices si
      ON si.id = e.source_id
     AND si.company_id = p_company_id
    JOIN public.suppliers s
      ON s.id = si.supplier_id
     AND s.company_id = p_company_id
   WHERE e.source_type IN ('supplier_invoice_registered', 'supplier_invoice_cash_payment')
  UNION ALL
  SELECT 'inbox_item'::text,
         public.grant_counterparty_key(n.name, NULL, NULL),
         g.gross
    FROM entry e
    JOIN public.invoice_inbox_items i
      ON i.id = e.source_id
     AND i.company_id = p_company_id
    LEFT JOIN public.suppliers s
      ON s.id = i.matched_supplier_id
     AND s.company_id = p_company_id
   CROSS JOIN LATERAL (
     SELECT greatest(coalesce(sum(l.debit_amount), 0), coalesce(sum(l.credit_amount), 0)) AS gross
       FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id
        AND l.account_number !~ '^26'
   ) g
   CROSS JOIN LATERAL (VALUES (s.name), (i.extracted_data->'supplier'->>'name')) AS n(name)
   WHERE e.source_type = 'inbox_item'
  UNION ALL
  SELECT 'expense_claim'::text,
         public.grant_counterparty_key(i.extracted_data->'supplier'->>'name', NULL, NULL),
         ec.amount_sek
    FROM entry e
    JOIN public.expense_claims ec
      ON ec.id = e.source_id
     AND ec.company_id = p_company_id
    LEFT JOIN public.invoice_inbox_items i
      ON i.id = nullif(ec.metadata->>'inbox_item_id', '')::uuid
     AND i.company_id = p_company_id
   WHERE e.source_type = 'expense_claim'
$$;

COMMENT ON FUNCTION public.booking_review_entry_parties(uuid, uuid) IS
  'The counterparties a draft books, as hard blocks judge them: bank rows, supplier invoices, Inkorg items, and an expense claim seller when its reading names one. The claimant is never a counterparty. accounted#166.';

REVOKE ALL ON FUNCTION public.booking_review_entry_parties(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_review_entry_parties(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.booking_review_entry_matches(p_company_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_source_type text;
  v_context jsonb;
  v_lines jsonb;
  v_accounts text[];
  v_vat text[];
  v_matches jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_review_rules r WHERE r.company_id = p_company_id AND r.revoked_at IS NULL
  ) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT je.source_type, je.bank_booking_context
    INTO v_source_type, v_context
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id;
  IF NOT FOUND
     OR v_source_type IS NULL
     OR v_source_type NOT IN ('bank_transaction', 'manual', 'supplier_invoice_registered',
                              'supplier_invoice_cash_payment', 'inbox_item', 'expense_claim')
     OR (v_source_type IN ('bank_transaction', 'manual')
         AND jsonb_array_length(coalesce(v_context, '[]'::jsonb)) = 0) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_number', l.account_number,
           'debit_amount', l.debit_amount,
           'credit_amount', l.credit_amount)), '[]'::jsonb),
         coalesce(array_agg(DISTINCT l.account_number), '{}')
    INTO v_lines, v_accounts
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;
  v_vat := public.booking_review_vat_classes(v_lines);

  WITH parties AS (
    SELECT p.counterparty_key, p.amount_sek
      FROM public.booking_review_entry_parties(p_company_id, p_entry_id) AS p
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'rule_id', r.rule_id, 'version', r.version)
                            ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_matches
    FROM public.booking_review_rules r
   WHERE r.company_id = p_company_id
     AND r.revoked_at IS NULL
     AND r.valid_from <= now()
     AND (r.accounts IS NULL OR r.accounts && v_accounts)
     AND (r.vat_treatment IS NULL OR r.vat_treatment = ANY (v_vat))
     AND ((r.counterparty_key IS NULL AND r.amount_from_sek IS NULL)
          OR EXISTS (
            SELECT 1 FROM parties b
             WHERE (r.counterparty_key IS NULL OR b.counterparty_key = r.counterparty_key)
               AND (r.amount_from_sek IS NULL OR b.amount_sek >= r.amount_from_sek)));
  RETURN v_matches;
END;
$$;

REVOKE ALL ON FUNCTION public.booking_review_entry_matches(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_review_entry_matches(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
