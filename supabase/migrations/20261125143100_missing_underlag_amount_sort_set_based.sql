-- The missing-underlag filter sorted by Belopp reads the amounts of its whole
-- set in one pass, and display_amount goes: the Belopp rule
-- (src/lib/bookkeeping/voucher-display-amount.ts) keeps one SQL body,
-- verifikat_display_amounts (20261125130100).
--
-- list_verifikat_missing_underlag ordered an amount sort by the
-- display_amount computed column (20261018135300), called once for every
-- verifikat of the missing set before the first page could be taken: a
-- SECURITY DEFINER SQL function, so never inlined, that checked the caller's
-- companies again on every call. The verifikat list's own Belopp sort left
-- that column for the set function in 20261125130100.
--
-- 1. list_verifikat_missing_underlag, restated from 20261023093930 with only
--    the amount changed: when the sort asks for it, the missing set's amounts
--    come from verifikat_display_amounts in one statement, joined by id. Any
--    other sort reads no amount, as before. The set, the filters, the order
--    allowlist, the tiebreak, the paging and the {ok, total_count, ids}
--    answer are unchanged. The caller's membership is still checked once, at
--    the top. display_amount checked it again on every row, which a member
--    always passed; a caller without a user (the service role) got no amount
--    from it and gets the real one now. Nothing sorts by amount that way: the
--    list calls this with the user's session.
-- 2. display_amount is dropped. Nothing reads it any more: the list's Belopp
--    sort calls list_verifikat_by_amount, this function calls the set
--    function, and no code selects or orders by the computed column. Kept,
--    it would be a second body of the rule, and a per-row column that
--    invites the slow sort back.
--
-- pg-test: tests/pg/list-verifikat-missing-underlag.pg.test.ts

-- 1. The missing-underlag page, its amounts read for the set ----------------

CREATE OR REPLACE FUNCTION public.list_verifikat_missing_underlag(
  p_company_id uuid,
  p_period_id uuid DEFAULT NULL,
  p_series text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_search_pattern text DEFAULT NULL,
  p_search_voucher_series text DEFAULT NULL,
  p_search_voucher_number integer DEFAULT NULL,
  p_order text[] DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  -- 1,000 = the most rows one list request carries (MAX_ROWS_PER_REQUEST).
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_token text;
  v_fragment text;
  v_terms text[] := ARRAY[]::text[];
  v_with_amount boolean := false;
  v_order_sql text;
  v_ranked_sql text;
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_MISSING_UNDERLAG_FORBIDDEN');
    END IF;
  END IF;

  IF coalesce(array_length(p_order, 1), 0) > 8 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_MISSING_UNDERLAG_INVALID_ORDER');
  END IF;

  FOREACH v_token IN ARRAY coalesce(p_order, ARRAY[]::text[]) LOOP
    v_fragment := CASE v_token
      WHEN 'entry_date.asc' THEN 'entry_date ASC'
      WHEN 'entry_date.desc' THEN 'entry_date DESC'
      WHEN 'voucher_series.asc' THEN 'voucher_series ASC'
      WHEN 'voucher_series.desc' THEN 'voucher_series DESC'
      WHEN 'voucher_number.asc' THEN 'voucher_number ASC'
      WHEN 'voucher_number.desc' THEN 'voucher_number DESC'
      WHEN 'description.asc' THEN 'description ASC'
      WHEN 'description.desc' THEN 'description DESC'
      WHEN 'display_amount.asc' THEN 'display_amount ASC'
      WHEN 'display_amount.desc' THEN 'display_amount DESC'
      WHEN 'id.asc' THEN 'id ASC'
      WHEN 'id.desc' THEN 'id DESC'
    END;
    IF v_fragment IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_MISSING_UNDERLAG_INVALID_ORDER');
    END IF;
    v_terms := v_terms || v_fragment;
    IF v_token LIKE 'display_amount.%' THEN
      v_with_amount := true;
    END IF;
  END LOOP;
  -- A total order whatever the caller sent: ids are unique.
  v_order_sql := array_to_string(v_terms || 'id ASC'::text, ', ');

  -- The amount the Belopp column shows, only when the sort asks for it: for
  -- the whole missing set in one statement, not one call per verifikat. Both
  -- texts are constants; no caller text reaches the statement.
  v_ranked_sql := CASE
    WHEN v_with_amount THEN
      'SELECT m.*, a.display_amount FROM missing m '
      || 'LEFT JOIN public.verifikat_display_amounts($1, ARRAY(SELECT mm.id FROM missing mm)) a '
      || 'ON a.journal_entry_id = m.id'
    ELSE
      'SELECT m.*, NULL::numeric AS display_amount FROM missing m'
  END;

  EXECUTE format($sql$
    WITH missing AS MATERIALIZED (
      SELECT
        je.id,
        je.entry_date,
        je.voucher_series,
        je.voucher_number,
        je.description
      FROM public.journal_entries je
      WHERE je.company_id = $1
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
          'webshop_order',
          'inbox_item',
          'pos_daily_sales'
        )
        -- Superseded document versions do not satisfy BFL underlag.
        AND NOT EXISTS (
          SELECT 1 FROM public.document_attachments d
          WHERE d.company_id = $1
            AND d.journal_entry_id = je.id AND d.is_current_version = true
        )
        -- Explicitly waived ("Inget underlag krävs").
        AND NOT EXISTS (
          SELECT 1 FROM public.journal_entry_no_doc_required x
          WHERE x.company_id = $1
            AND x.journal_entry_id = je.id
        )
        -- BFL 5 kap 7 § hänvisning, supplier side: a supplier invoice whose
        -- retained document is ANCHORED to a journal entry covers both its
        -- registration and its payment verifikat.
        AND NOT EXISTS (
          SELECT 1
          FROM public.supplier_invoices si
          JOIN public.document_attachments sd ON sd.id = si.document_id
          WHERE si.company_id = $1
            AND sd.journal_entry_id IS NOT NULL
            AND (si.registration_journal_entry_id = je.id
              OR si.payment_journal_entry_id = je.id)
        )
        -- Partial payments link through supplier_invoice_payments.
        AND NOT EXISTS (
          SELECT 1
          FROM public.supplier_invoice_payments sip
          JOIN public.supplier_invoices sip_si ON sip_si.id = sip.supplier_invoice_id
          JOIN public.document_attachments sipd ON sipd.id = sip_si.document_id
          WHERE sip.journal_entry_id = je.id
            AND sip_si.company_id = $1
            AND sipd.journal_entry_id IS NOT NULL
        )
        -- BFL 5 kap 7 § hänvisning, customer side (#2298): an ISSUED register
        -- invoice pointing at the entry (registration link or payment row).
        AND NOT EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.company_id = $1
            AND i.journal_entry_id = je.id
            AND i.status NOT IN ('draft', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.invoice_payments ip
          JOIN public.invoices ipi ON ipi.id = ip.invoice_id
          WHERE ip.company_id = $1
            AND ip.journal_entry_id = je.id
            AND ipi.status NOT IN ('draft', 'cancelled')
        )
        -- The list's filters.
        AND ($2::uuid IS NULL OR je.fiscal_period_id = $2)
        AND ($3::text IS NULL OR je.voucher_series = $3)
        AND ($4::date IS NULL OR je.entry_date >= $4)
        AND ($5::date IS NULL OR je.entry_date <= $5)
        -- Same search as the direct list query: the description, and a
        -- voucher-label needle ("A209") also matches series + number.
        AND (
          $6::text IS NULL
          OR je.description ILIKE $6
          OR ($7::text IS NOT NULL AND je.voucher_series = $7 AND je.voucher_number = $8)
        )
    ),
    ranked AS (
      %2$s
    ),
    page AS (
      SELECT * FROM ranked
      ORDER BY %1$s
      LIMIT $9 OFFSET $10
    )
    SELECT jsonb_build_object(
      'ok', true,
      'total_count', (SELECT count(*) FROM missing),
      'ids', coalesce((SELECT jsonb_agg(id ORDER BY %1$s) FROM page), '[]'::jsonb)
    )
  $sql$, v_order_sql, v_ranked_sql)
  INTO v_result
  USING
    p_company_id,
    p_period_id,
    p_series,
    p_date_from,
    p_date_to,
    p_search_pattern,
    p_search_voucher_series,
    p_search_voucher_number,
    v_limit,
    v_offset;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.list_verifikat_missing_underlag(uuid, uuid, text, date, date, text, text, integer, text[], integer, integer) IS
  'The verifikat list''s missing-underlag filter: the verifikat_without_documents predicate narrowed by the list''s filters, sorted and paged in one statement, an amount sort through verifikat_display_amounts. Returns {ok, total_count, ids}.';

REVOKE ALL ON FUNCTION public.list_verifikat_missing_underlag(uuid, uuid, text, date, date, text, text, integer, text[], integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_verifikat_missing_underlag(uuid, uuid, text, date, date, text, text, integer, text[], integer, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.verifikat_display_amounts(uuid, uuid[]) IS
  'The amount the verifikat list shows (the single money line, else the omslutning) for each given verifikat of the company, in one statement: the one SQL body of the Belopp rule. Mirrors src/lib/bookkeeping/voucher-display-amount.ts. Internal: checks no membership; list_verifikat_by_amount and list_verifikat_missing_underlag call it after their own check.';

-- 2. The per-row column goes -------------------------------------------------

DROP FUNCTION public.display_amount(public.journal_entries);

NOTIFY pgrst, 'reload schema';
