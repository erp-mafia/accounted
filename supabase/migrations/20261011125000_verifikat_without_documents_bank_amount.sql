-- verifikat_without_documents.gross_amount stops counting self-assessed
-- reverse-charge and import moms (crm#1062).
--
-- gross_amount was the voucher's debit total. On a purchase under omvänd
-- betalningsskyldighet (an EU or non-EU service, an intra-EU acquisition,
-- domestic byggtjänster) or an import of goods, the buyer books the output
-- VAT itself (2614/2624/2634, 2615/2625/2635) against calculated input VAT
-- (2645, 2647) on the same verifikat. Neither leg is on the supplier's
-- invoice or the bank row, but the debit total carries the input leg, so a
-- 1 000 kr foreign invoice paid with 1 000 kr reported 1 250 kr. Every
-- consumer of the field means the amount of the affärshändelse as its
-- underlag shows it: the MCP list an agent matches receipts and bank rows
-- against, the receipt hunt worklist's amount and ranking, and the 4 000 kr
-- floor in the VAT close check (ML 17 kap 26-28 §, a figure inclusive of
-- the moms the seller charged; a reverse-charge invoice charges none). So
-- the definition changes here, once, and p_min_amount, total_count and the
-- page follow it. No caller needs the old figure.
--
-- Body identical to 20260920150000 except the gross_amount expression and
-- the min_amount filter, which moves from a HAVING that repeated the
-- expression to a `matching` CTE reading the computed column. Same
-- signature: CREATE OR REPLACE keeps the grants; they are restated for
-- clarity. transactions_without_documents reports the bank row's own amount
-- and is unchanged.
--
-- pg-test: tests/pg/verifikat-without-documents-rpc.pg.test.ts

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
        'webshop_order',
        'inbox_item'
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
      -- scoped on the link row, never on the entry alone. The invoice must
      -- be ISSUED: a draft or cancelled invoice is no document (the schema
      -- agrees: outside those two statuses an invoice_number is required,
      -- migration 20260427150000), the counterpart of the anchored-document
      -- requirement on the supplier arms. Mirrors NON_ISSUED_INVOICE_STATUSES
      -- (lib/invoices/matchable-statuses.ts).
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.company_id = p_company_id
          AND i.journal_entry_id = je.id
          AND i.status NOT IN ('draft', 'cancelled')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM invoice_payments ip
        JOIN invoices ipi ON ipi.id = ip.invoice_id
        WHERE ip.company_id = p_company_id
          AND ip.journal_entry_id = je.id
          AND ipi.status NOT IN ('draft', 'cancelled')
      )
      AND (p_since IS NULL OR je.entry_date >= p_since)
    GROUP BY je.id
  ),
  -- min_amount filters on the same gross_amount the rows report: one
  -- definition, so the filter, total_count and the page cannot disagree.
  matching AS (
    SELECT * FROM candidates WHERE gross_amount >= v_min
  ),
  total AS (
    SELECT count(*) AS n FROM matching
  ),
  page AS (
    SELECT * FROM matching
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
