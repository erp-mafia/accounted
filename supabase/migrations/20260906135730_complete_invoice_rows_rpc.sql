-- complete_invoice_rows: write a migrated invoice's rows at most once.
--
-- Two writers put invoice_items under MIGRATED sales invoices: the migration
-- wizard (rows inserted milliseconds after the invoice header) and the hourly
-- row-completion pass (#2291, extensions/general/arcim-migration/lib/
-- complete-invoice-lines.ts) that fetches the rows the wizard's hydration
-- budget did not reach. Both were check-then-insert across two statements
-- with nothing serializing them per invoice: invoice_items carries only a
-- non-unique index on invoice_id, so two writers landing on the same invoice
-- at once both succeeded and doubled its rows (#2313, recorded as an accepted
-- residual on #2291). The pass also wrote the header VAT split in a third
-- statement, so "rows landed, header did not" was a reachable state that the
-- next run could not revisit (the invoice now had rows).
--
-- This RPC is the one write path for both. It locks the invoice row
-- (FOR UPDATE, scoped to the company), inserts the rows only when the invoice
-- still has none, and applies the optional header split in the same
-- transaction. A concurrent caller for the same invoice queues on the lock
-- and, once the first commits, reads the rows and returns wrote = false. The
-- invariant is "an invoice's rows are written at most once by the completion
-- writers"; it needs no unique index and therefore no clean-up of the legacy
-- rows that carry duplicate sort_order values within one invoice.
--
-- Column set: exactly what mapSalesInvoiceLine emits. An unknown key is
-- refused (UNKNOWN_COLUMN) rather than dropped, so a mapper that starts
-- emitting a column this function does not carry fails loudly instead of
-- silently losing it. The facts a sales row must state (description,
-- line_total, vat_rate, vat_amount; ML 17 kap 24 §) are required
-- (MISSING_REQUIRED) rather than defaulted: the table's DEFAULT 25 on
-- vat_rate would put a fabricated 25 % on a row whose source said nothing,
-- and both writers always send all four, so a missing one is a bug to
-- surface, not a gap to fill. Only sort_order, quantity, unit and line_type
-- take their table defaults; none of them states a tax fact. The rate is
-- not restricted to the Swedish set: 0 (omvänd skattskyldighet, export) and
-- foreign rates (OSS, unionsordningen) are legitimate on a migrated row.
--
-- Actor resolution mirrors the sibling definer RPCs: service_role callers
-- (the cron on createServiceClientNoCookies, auth.uid() NULL) are trusted,
-- the same trust a direct service-role insert already carries; every other
-- caller is pinned to auth.uid() and must hold a write role (owner, admin or
-- member) in p_company_id, the same gate as invoice_items_insert. A caller
-- with no JWT at all is refused.
--
-- pg-test: tests/pg/complete-invoice-rows-rpc.pg.test.ts

CREATE OR REPLACE FUNCTION public.complete_invoice_rows(
  p_company_id uuid,
  p_invoice_id uuid,
  p_rows jsonb,
  p_header jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
  v_locked uuid;
  v_bad_key text;
  v_missing text;
  v_inserted integer := 0;
  v_header_updated boolean := false;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    v_caller := auth.uid();
    IF v_caller IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
    END IF;
    -- SECURITY DEFINER bypasses RLS, so the write-role gate is explicit.
    IF NOT EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = p_company_id
        AND cm.user_id = v_caller
        AND cm.role IN ('owner', 'admin', 'member')
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
    END IF;
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ROWS');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e WHERE jsonb_typeof(e) <> 'object') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ROWS');
  END IF;

  SELECT k INTO v_bad_key
  FROM jsonb_array_elements(p_rows) AS e, jsonb_object_keys(e) AS k
  WHERE k NOT IN (
    'sort_order', 'description', 'quantity', 'unit', 'unit_price',
    'line_total', 'vat_rate', 'vat_amount', 'line_type'
  )
  LIMIT 1;
  IF v_bad_key IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNKNOWN_COLUMN',
      'details', jsonb_build_object('column', v_bad_key));
  END IF;

  -- Absent or JSON null: either would otherwise fall through to a default.
  SELECT k INTO v_missing
  FROM jsonb_array_elements(p_rows) AS e,
       unnest(ARRAY['description', 'line_total', 'vat_rate', 'vat_amount']) AS k
  WHERE NOT (e ? k) OR jsonb_typeof(e -> k) = 'null'
  LIMIT 1;
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MISSING_REQUIRED',
      'details', jsonb_build_object('column', v_missing));
  END IF;

  IF p_header IS NOT NULL THEN
    -- All six or nothing: a partial header would null the columns it omits.
    IF jsonb_typeof(p_header) <> 'object' OR NOT (p_header ?& ARRAY[
      'subtotal', 'subtotal_sek', 'vat_amount', 'vat_amount_sek', 'vat_rate', 'vat_treatment'
    ]) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_HEADER');
    END IF;
  END IF;

  -- The per-invoice serialization point. A concurrent writer for the same
  -- invoice waits here and sees the committed rows below.
  SELECT i.id INTO v_locked
  FROM public.invoices i
  WHERE i.id = p_invoice_id
    AND i.company_id = p_company_id
  FOR UPDATE;
  IF v_locked IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_NOT_FOUND');
  END IF;

  IF EXISTS (SELECT 1 FROM public.invoice_items ii WHERE ii.invoice_id = p_invoice_id) THEN
    RETURN jsonb_build_object('ok', true, 'wrote', false, 'rows', 0, 'header_updated', false);
  END IF;

  INSERT INTO public.invoice_items
    (invoice_id, sort_order, description, quantity, unit, unit_price,
     line_total, vat_rate, vat_amount, line_type)
  SELECT
    p_invoice_id,
    COALESCE(r.sort_order, 0),
    r.description,
    COALESCE(r.quantity, 1),
    COALESCE(r.unit, 'st'),
    COALESCE(r.unit_price, 0),
    r.line_total,
    r.vat_rate,
    r.vat_amount,
    COALESCE(r.line_type, 'product')
  FROM jsonb_to_recordset(p_rows) AS r(
    sort_order integer,
    description text,
    quantity numeric,
    unit text,
    unit_price numeric,
    line_total numeric,
    vat_rate numeric,
    vat_amount numeric,
    line_type text
  );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF p_header IS NOT NULL THEN
    UPDATE public.invoices
    SET subtotal = (p_header ->> 'subtotal')::numeric,
        subtotal_sek = (p_header ->> 'subtotal_sek')::numeric,
        vat_amount = (p_header ->> 'vat_amount')::numeric,
        vat_amount_sek = (p_header ->> 'vat_amount_sek')::numeric,
        vat_rate = (p_header ->> 'vat_rate')::numeric,
        vat_treatment = p_header ->> 'vat_treatment'
    WHERE id = p_invoice_id
      AND company_id = p_company_id;
    v_header_updated := true;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'wrote', true,
    'rows', v_inserted,
    'header_updated', v_header_updated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_invoice_rows(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_invoice_rows(uuid, uuid, jsonb, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_invoice_rows(uuid, uuid, jsonb, jsonb) IS
  'Writes a migrated invoice''s rows (and optionally its header VAT split) at most once: locks the invoice, inserts only when it has no rows, returns wrote = false otherwise. The one write path for the migration wizard and the row-completion pass.';

NOTIFY pgrst, 'reload schema';
