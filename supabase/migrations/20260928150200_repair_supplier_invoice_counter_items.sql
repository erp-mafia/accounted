-- One-off repair for supplier invoice rows the provider migration stored with
-- the source voucher's payable leg among them (see the previous migration,
-- 20260928150100_supplier_invoice_items_not_payable_account).
--
-- repair_supplier_invoice_counter_items looks at every supplier invoice in ONE
-- company that has a row on a 244x account, and decides from its rows alone:
--
--   exact             the other rows add up to the invoice total to the öre.
--                     The 244x rows are removed and every remaining row gets
--                     vat_rate 0: the header established no VAT and no row
--                     carries a VAT amount, and an old default rate beside
--                     them would make the booking engine add 25 % on top of
--                     the 2641 row the source already booked.
--   rounding_flipped  the other rows are off by exactly twice their one 3740
--                     row, all rows positive: Visma rows were imported without
--                     their side, so an öresavrundning CREDIT read as a debit.
--                     That row changes sign, then as exact.
--   unreconciled      anything else: a reverse-charge or SLP pair imported
--                     without its side, rows in another currency than the
--                     header, a lone 2440 row. No row of such a set can be
--                     trusted. Reported; with p_clear_unreconciled the
--                     invoice's rows are all removed, so it reads as imported
--                     without rows, which is what the fixed importer does with
--                     rows that do not add up. A provider migration run
--                     refills rows for an invoice that has none.
--   skipped_voucher   a verifikat was generated from the rows: registration,
--                     kontantmetod payment, privately paid, or a credit note
--                     of or against the invoice. The rows are what that entry
--                     was built from and stay exactly as they are; the entry
--                     itself needs a human decision (storno), never this RPC.
--   skipped_vat       the header or a row states VAT, which is not the shape
--                     the migration wrote. Left alone.
--
-- Never touches a journal entry or the invoice header. Dry run by default, one
-- company per call, a write needs an actor, service_role only, never run by a
-- loop. Every invoice written gets one SupplierInvoiceCounterRowsRepaired
-- event with its rows before and after (every column but the free-text
-- description and unit: processing_history holds pseudonymous data only, see
-- lib/processing-history/append.ts), so a run can be reviewed and reversed.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('SupplierInvoiceCounterRowsRepaired')
ON CONFLICT (event_type) DO NOTHING;

CREATE FUNCTION public.repair_supplier_invoice_counter_items(
  p_company_id uuid,
  p_dry_run boolean DEFAULT true,
  p_clear_unreconciled boolean DEFAULT false,
  p_actor jsonb DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL
)
RETURNS TABLE (
  supplier_invoice_id uuid,
  invoice_status text,
  currency text,
  total numeric,
  payable_rows integer,
  other_rows_total numeric,
  outcome text,
  selected boolean,
  repaired boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
-- The result columns share names with table columns (currency, total, ...);
-- inside a query a bare name always means the column.
#variable_conflict use_column
DECLARE
  v_correlation_id uuid := COALESCE(p_correlation_id, gen_random_uuid());
  v_invoice_id uuid;
  c record;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'repair_supplier_invoice_counter_items: p_company_id is required, this never runs across companies'
      USING ERRCODE = '22023';
  END IF;
  IF NOT p_dry_run AND (
       p_actor IS NULL
       OR jsonb_typeof(p_actor) <> 'object'
       OR COALESCE(p_actor->>'type', '') = ''
       OR COALESCE(p_actor->>'id', '') = '') THEN
    RAISE EXCEPTION 'repair_supplier_invoice_counter_items: p_actor {type, id} is required for a write'
      USING ERRCODE = '22023';
  END IF;

  FOR v_invoice_id IN
    SELECT si.id
    FROM public.supplier_invoices si
    WHERE si.company_id = p_company_id
      AND EXISTS (
        SELECT 1 FROM public.supplier_invoice_items i
        WHERE i.supplier_invoice_id = si.id AND i.account_number ~ '^244')
    ORDER BY si.invoice_date, si.id
  LOOP
    -- A write decides under the invoice's row lock, so a payment or a booking
    -- that starts from these rows meanwhile is seen, not raced.
    IF NOT p_dry_run THEN
      PERFORM 1 FROM public.supplier_invoices
        WHERE id = v_invoice_id AND company_id = p_company_id
        FOR UPDATE;
    END IF;

    SELECT
      si.status,
      si.currency,
      si.total,
      (si.vat_amount <> 0 OR si.subtotal <> si.total OR r.any_row_vat) AS states_vat,
      r.payable_rows,
      r.other_rows_total,
      r.any_negative,
      r.rounding_rows,
      r.rounding_id,
      r.rounding_amount,
      EXISTS (
        SELECT 1
        FROM public.journal_entries je
        WHERE je.company_id = p_company_id
          AND je.source_type IN ('supplier_invoice_registered', 'supplier_invoice_cash_payment',
                                 'supplier_invoice_privately_paid', 'supplier_credit_note', 'expense_claim')
          AND (je.source_id = si.id
            OR je.id = si.registration_journal_entry_id
            OR je.id = si.payment_journal_entry_id
            OR je.id IN (
              SELECT p.journal_entry_id FROM public.supplier_invoice_payments p
              WHERE p.supplier_invoice_id = si.id)
            OR je.source_id IN (
              SELECT cn.id FROM public.supplier_invoices cn
              WHERE cn.company_id = p_company_id AND cn.credited_invoice_id = si.id))
      ) AS booked_from_rows
    INTO c
    FROM public.supplier_invoices si
    CROSS JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE i.account_number ~ '^244')::integer AS payable_rows,
        round(COALESCE(sum(i.line_total) FILTER (WHERE i.account_number !~ '^244'), 0), 2) AS other_rows_total,
        COALESCE(bool_or(i.line_total < 0), false) AS any_negative,
        COALESCE(bool_or(i.vat_amount <> 0), false) AS any_row_vat,
        count(*) FILTER (WHERE i.account_number = '3740')::integer AS rounding_rows,
        (array_agg(i.id) FILTER (WHERE i.account_number = '3740'))[1] AS rounding_id,
        (array_agg(i.line_total) FILTER (WHERE i.account_number = '3740'))[1] AS rounding_amount
      FROM public.supplier_invoice_items i
      WHERE i.supplier_invoice_id = si.id
    ) r
    WHERE si.id = v_invoice_id;

    -- Gone, or repaired by a concurrent call, between the scan and the lock.
    CONTINUE WHEN NOT FOUND OR c.payable_rows = 0;

    supplier_invoice_id := v_invoice_id;
    invoice_status := c.status;
    currency := c.currency;
    total := c.total;
    payable_rows := c.payable_rows;
    other_rows_total := c.other_rows_total;
    outcome := CASE
      WHEN c.booked_from_rows THEN 'skipped_voucher'
      WHEN c.states_vat THEN 'skipped_vat'
      WHEN c.other_rows_total = c.total THEN 'exact'
      WHEN NOT c.any_negative AND c.rounding_rows = 1
        AND round(c.other_rows_total - 2 * c.rounding_amount, 2) = c.total THEN 'rounding_flipped'
      ELSE 'unreconciled'
    END;
    selected := outcome IN ('exact', 'rounding_flipped')
      OR (outcome = 'unreconciled' AND p_clear_unreconciled);
    repaired := false;

    IF NOT p_dry_run AND selected THEN
      SELECT jsonb_agg(to_jsonb(i) - ARRAY['description', 'unit'] ORDER BY i.sort_order, i.id)
        INTO v_before
        FROM public.supplier_invoice_items i
        WHERE i.supplier_invoice_id = v_invoice_id;

      IF outcome = 'unreconciled' THEN
        DELETE FROM public.supplier_invoice_items i WHERE i.supplier_invoice_id = v_invoice_id;
      ELSE
        DELETE FROM public.supplier_invoice_items i
          WHERE i.supplier_invoice_id = v_invoice_id AND i.account_number ~ '^244';
        -- Rates first: a legacy percent-shaped rate (25) fails the vat_rate
        -- fraction check on any UPDATE of its row, the sign flip included.
        UPDATE public.supplier_invoice_items i SET vat_rate = 0
          WHERE i.supplier_invoice_id = v_invoice_id AND i.vat_rate <> 0;
        IF outcome = 'rounding_flipped' THEN
          UPDATE public.supplier_invoice_items i
            SET line_total = -i.line_total, unit_price = -i.unit_price
            WHERE i.id = c.rounding_id;
        END IF;
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(i) - ARRAY['description', 'unit'] ORDER BY i.sort_order, i.id), '[]'::jsonb)
        INTO v_after
        FROM public.supplier_invoice_items i
        WHERE i.supplier_invoice_id = v_invoice_id;

      INSERT INTO public.processing_history
        (company_id, correlation_id, aggregate_type, aggregate_id, event_type, payload, actor, occurred_at)
      VALUES (
        p_company_id,
        v_correlation_id,
        'SupplierInvoice',
        v_invoice_id,
        'SupplierInvoiceCounterRowsRepaired',
        jsonb_build_object(
          'rule', outcome,
          'total', c.total,
          'currency', c.currency,
          'before', v_before,
          'after', v_after
        ),
        p_actor,
        now()
      );
      repaired := true;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.repair_supplier_invoice_counter_items(uuid, boolean, boolean, jsonb, uuid) IS
  'Lists (dry run, default) or repairs, for ONE company, supplier invoices whose rows include the source voucher''s 244x payable row. exact: the other rows equal the total, so the 244x rows go and every row gets vat_rate 0. rounding_flipped: a single 3740 row imported without its side is flipped, then as exact. unreconciled: reported, and its rows removed only with p_clear_unreconciled. Invoices with a verifikat generated from their rows, or with VAT on the header or a row, are reported and never written. Never touches a journal entry or the invoice header; logs one SupplierInvoiceCounterRowsRepaired event per repaired invoice with its rows before and after. service_role only; a write requires p_actor.';

REVOKE ALL ON FUNCTION public.repair_supplier_invoice_counter_items(uuid, boolean, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_supplier_invoice_counter_items(uuid, boolean, boolean, jsonb, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
