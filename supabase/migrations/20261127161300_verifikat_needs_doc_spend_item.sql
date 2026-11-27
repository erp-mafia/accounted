-- spend_item joins the needs-doc list of the verifikat surface.
--
-- A company card expense is booked with its receipt files attached
-- (lib/spend/book-item.ts). The receipt arrives from the provider and is
-- linked after the commit, so a verifikat whose receipt did not attach (or
-- that the provider sent without one) must surface as "Underlag saknas"
-- like a POS day or a webshop order does (BFL 5 kap 7 §). The transactions
-- surface stays as it is: a card expense on the wallet has no bank line.
--
-- The function body is that of 20261028103000 (the latest definition) with
-- the one added source type. Same signature, six arguments: CREATE OR
-- REPLACE keeps the grants; they are restated.
--
-- The partial index the needs-doc set is read from
-- (idx_journal_entries_posted_needs_doc, 20261023093920) holds exactly the
-- needs-doc source types, so it is rebuilt with the new one: a list that
-- differs from the index's still answers the same, only without the index.
-- Plain CREATE INDEX, as there: CONCURRENTLY cannot run inside the migration
-- transaction, and writes to journal_entries wait for the seconds the build
-- takes.
--
-- Keep the needs-doc list in lockstep with NEEDS_DOC_SOURCE_TYPES
-- (lib/worklist/types.ts), here, in the index and in
-- list_verifikat_missing_underlag below.
--
-- pg-test: tests/pg/document-surfaces-unification.pg.test.ts and tests/pg/list-verifikat-missing-underlag.pg.test.ts

DROP INDEX IF EXISTS public.idx_journal_entries_posted_needs_doc;

CREATE INDEX idx_journal_entries_posted_needs_doc
  ON public.journal_entries (company_id, entry_date, voucher_number, id)
  WHERE status = 'posted'
    AND source_type IN (
      'manual',
      'bank_transaction',
      'supplier_invoice_registered',
      'supplier_invoice_paid',
      'supplier_invoice_cash_payment',
      'import',
      'webshop_order',
      'inbox_item',
      'pos_daily_sales',
      'spend_item'
    );

CREATE OR REPLACE FUNCTION public.verifikat_without_documents(
  p_company_id uuid,
  p_since date DEFAULT NULL,
  p_min_amount numeric DEFAULT 0,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_until date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
-- Every scan here is one company's: starting parallel workers for them costs
-- more than they save.
SET max_parallel_workers_per_gather TO 0
-- Planned for the company and filters it is called with: the cached generic
-- plan was 10-20 ms slower per call.
SET plan_cache_mode TO force_custom_plan
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

  -- needs_doc: the company's posted verifikat whose affärshändelse requires
  -- an underlag, read once. Each NOT EXISTS below is resolved as one hash
  -- anti join against a company-scoped set, and lines are summed only for the
  -- verifikat left over.
  WITH needs_doc AS MATERIALIZED (
    SELECT je.id, je.voucher_number, je.entry_date
    FROM journal_entries je
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
        'webshop_order',
        'inbox_item',
        'pos_daily_sales',
        'spend_item'
      )
      AND (p_since IS NULL OR je.entry_date >= p_since)
      AND (p_until IS NULL OR je.entry_date <= p_until)
  ),
  -- The company's current documents on a verifikat. Superseded versions do
  -- not satisfy BFL underlag. Only the company's own documents count:
  -- another company's file is not this company's underlag (none is attached
  -- across companies in production), and reading them once is what lets the
  -- anti join below hash instead of probing per verifikat.
  current_documents AS MATERIALIZED (
    SELECT d.journal_entry_id
    FROM document_attachments d
    WHERE d.company_id = p_company_id
      AND d.journal_entry_id IS NOT NULL
      AND d.is_current_version = true
  ),
  -- The company's supplier invoices whose source document is ANCHORED
  -- (journal_entry_id set): only anchored docs sit behind the WORM deletion
  -- guards, so an unanchored doc cannot legally back a posted verifikat and
  -- must keep the warning alive. Shared by the three supplier arms below.
  supplier_invoices_with_document AS MATERIALIZED (
    SELECT si.id, si.registration_journal_entry_id, si.payment_journal_entry_id
    FROM supplier_invoices si
    JOIN document_attachments sd ON sd.id = si.document_id
    WHERE si.company_id = p_company_id
      AND sd.journal_entry_id IS NOT NULL
  ),
  -- The company's ISSUED invoices: a draft or cancelled invoice is no
  -- document (outside those two statuses an invoice_number is required,
  -- migration 20260427150000). Mirrors NON_ISSUED_INVOICE_STATUSES
  -- (lib/invoices/matchable-statuses.ts). Shared by the two customer arms.
  issued_invoices AS MATERIALIZED (
    SELECT i.id, i.journal_entry_id
    FROM invoices i
    WHERE i.company_id = p_company_id
      AND i.status NOT IN ('draft', 'cancelled')
  ),
  missing AS MATERIALIZED (
    SELECT n.*
    FROM needs_doc n
    WHERE NOT EXISTS (
        SELECT 1 FROM current_documents d
        WHERE d.journal_entry_id = n.id
      )
      -- Explicitly waived (e.g. internal transfers): user decided no
      -- underlag is required; do not resurface to agents.
      AND NOT EXISTS (
        SELECT 1 FROM journal_entry_no_doc_required x
        WHERE x.company_id = p_company_id
          AND x.journal_entry_id = n.id
      )
      -- BFL 5 kap 7 §: hänvisning till underlag. An entry booked from a
      -- supplier invoice whose source document is retained is covered by
      -- that document even though the doc row hangs on the invoice's other
      -- verifikat (registration vs payment).
      AND NOT EXISTS (
        SELECT 1 FROM supplier_invoices_with_document s
        WHERE s.registration_journal_entry_id = n.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM supplier_invoices_with_document s
        WHERE s.payment_journal_entry_id = n.id
      )
      -- Partial payments link through supplier_invoice_payments instead of
      -- supplier_invoices.payment_journal_entry_id.
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoice_payments sip
        JOIN supplier_invoices_with_document s ON s.id = sip.supplier_invoice_id
        WHERE sip.journal_entry_id = n.id
      )
      -- BFL 5 kap 7 § hänvisning, customer side (#2298): an entry a register
      -- invoice points at is backed by that invoice. The invoice Accounted
      -- issued IS the verifikation for the sale, and the payment row
      -- identifies the inbetalning. Both links are written on the invoice
      -- side (registration booking, kontantmetod inbetalning, delbetalning,
      -- "matcha mot befintligt verifikat"), so an imported or manual entry
      -- keeps its own source_type and must be resolved from here. Tenant
      -- scoped on the link row, never on the entry alone. The invoice must
      -- be ISSUED, the counterpart of the anchored-document requirement on
      -- the supplier arms.
      AND NOT EXISTS (
        SELECT 1 FROM issued_invoices i
        WHERE i.journal_entry_id = n.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM invoice_payments ip
        JOIN issued_invoices i ON i.id = ip.invoice_id
        WHERE ip.company_id = p_company_id
          AND ip.journal_entry_id = n.id
      )
  ),
  -- The verifikat whose gross amount is needed: with a min_amount, every
  -- missing one (the filter reads it); without, only the requested page,
  -- since every gross amount passes a zero minimum (they are floored at 0).
  scope AS (
    SELECT m.*
    FROM missing m
    WHERE v_min > 0
    UNION ALL
    SELECT p.*
    FROM (
      SELECT m.*
      FROM missing m
      WHERE v_min = 0
      ORDER BY m.entry_date DESC, m.voucher_number DESC, m.id DESC
      LIMIT v_limit OFFSET v_offset
    ) p
  ),
  candidates AS (
    SELECT
      s.id,
      s.voucher_number,
      s.entry_date,
      -- The debit total less every self-assessed output VAT leg (reverse
      -- charge 2614/2624/2634, import 2615/2625/2635; the output accounts
      -- of REVERSE_CHARGE_VAT_ACCOUNTS, lib/bookkeeping/vat-entries.ts).
      -- A credit leg is offset by a debit (2645, 2647, 2641, or the cost
      -- when the moms is not deductible) and a credit note's debit leg is
      -- a debit itself, so each leg inflates the total by its own amount.
      -- Floored at zero: a verifikat that only moves self-assessed moms
      -- moved no money.
      round(greatest(
        coalesce(sum(l.debit_amount), 0)
          - coalesce(sum(l.debit_amount + l.credit_amount) FILTER (
              WHERE l.account_number IN ('2614', '2624', '2634', '2615', '2625', '2635')
            ), 0),
        0
      ), 2) AS gross_amount
    FROM scope s
    LEFT JOIN journal_entry_lines l ON l.journal_entry_id = s.id
    GROUP BY s.id, s.voucher_number, s.entry_date
  ),
  -- min_amount filters on the same gross_amount the rows report: one
  -- definition, so the filter, total_count and the page cannot disagree.
  matching AS (
    SELECT * FROM candidates WHERE gross_amount >= v_min
  ),
  total AS (
    SELECT CASE WHEN v_min > 0 THEN (SELECT count(*) FROM matching)
                ELSE (SELECT count(*) FROM missing)
           END AS n
  ),
  page AS (
    SELECT * FROM matching
    ORDER BY entry_date DESC, voucher_number DESC, id DESC
    -- Without a min_amount the scope already is the page.
    LIMIT v_limit OFFSET CASE WHEN v_min > 0 THEN v_offset ELSE 0 END
  ),
  -- The rest of a page row comes from its verifikat, for the page alone.
  page_rows AS (
    SELECT p.id, je.voucher_series, p.voucher_number, p.entry_date, je.description, je.source_type, p.gross_amount
    FROM page p
    JOIN journal_entries je ON je.id = p.id
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
       ) FROM page_rows p),
      '[]'::jsonb
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer, date) TO authenticated, service_role;

-- The verifikat list's missing-underlag filter carries its own copy of the
-- needs-doc list: list_verifikat_missing_underlag is restated from
-- 20261125143100 (the latest definition) with the same one source type
-- added. Same signature: CREATE OR REPLACE keeps the grants; they are
-- restated with its comment.

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
          'pos_daily_sales',
          'spend_item'
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

NOTIFY pgrst, 'reload schema';
