-- verifikat_without_documents, set-based: the same set, resolved once per
-- company instead of probed per verifikat.
--
-- The Hem row "Verifikat utan underlag", the sidebar badge, the VAT close
-- check and the MCP tool all call this RPC. It tested seven NOT EXISTS
-- conditions per posted verifikat and summed every candidate's lines before
-- filtering: for a company with 60 000 verifikat the planner probed the
-- documents index 28 000 times behind a cross-tenant source_type bitmap and
-- the call took ~240 ms, most of Hem's load time.
--
-- Now the needs-doc verifikat are read once, from a partial index that holds
-- exactly them, every NOT EXISTS is a hash anti join against a
-- company-scoped set, and lines are summed only for the verifikat that need
-- an amount: all the missing ones under a min_amount, the page's otherwise. The conditions are those of 20261011203300 with one
-- deliberate narrowing: a document and a "no underlag required" waiver count
-- only when they belong to the verifikat's own company. Another company's
-- file is not this company's underlag, the narrowing can only surface a
-- warning, never hide one, and production holds no document attached
-- across companies (checked 2026-10-23). Without it each of those two arms
-- is a probe per verifikat. Pinned by
-- tests/pg/verifikat-without-documents-rpc.pg.test.ts and
-- tests/pg/document-surfaces-unification.pg.test.ts. Same signature:
-- CREATE OR REPLACE keeps the grants; they are restated.
--
-- Keep the needs-doc list in lockstep with NEEDS_DOC_SOURCE_TYPES
-- (lib/worklist/types.ts), here and in the index below: a list that differs
-- from the index's still answers the same, only without the index.

-- The invoice-payment arm reads a company's payment rows; until now only
-- invoice and transaction ids were indexed (3 000 rows in production).
CREATE INDEX IF NOT EXISTS idx_invoice_payments_company_id ON public.invoice_payments (company_id);

-- The posted verifikat that need an underlag, with what the count and the
-- page order read, so the needs-doc set is an index-only scan instead of a
-- heap visit of every verifikat of the company.
CREATE INDEX IF NOT EXISTS idx_journal_entries_posted_needs_doc
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
      'pos_daily_sales'
    );

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
        'pos_daily_sales'
      )
      AND (p_since IS NULL OR je.entry_date >= p_since)
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

REVOKE ALL ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
