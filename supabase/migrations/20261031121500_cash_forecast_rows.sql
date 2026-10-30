-- cash_forecast_rows: money the company expects in or out on a day, that the
-- books do not know yet (accounted#136, part 1).
-- pg-test: tests/pg/cash-forecast-rows.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts,
--          tests/pg/full-archive-coverage.pg.test.ts
--
-- The liquidity forecast (src/lib/forecast) reads every flow the books and
-- registers already know: open customer and supplier invoices, the bank
-- payment queue, salary runs, the skattekonto and the tax deadlines,
-- recurring invoices. A forecast row is what none of them holds: a booking a
-- property management system knows before it is invoiced, a loan instalment,
-- a planned purchase. People, the v1 API and MCP write them.
--
-- A forecast row is not räkenskapsinformation: it never reaches a verifikat
-- and nothing here touches the books. That is why API and MCP callers write
-- rows directly under the forecast:write scope instead of staging them for
-- approval (decision 2026-10-28).
--
-- Rules:
--   * Idempotent upserts: an outside system names each row by
--     (external_source, external_id), unique per company, the pattern of
--     webshop_orders. Both or neither: a row typed in by a person has none.
--   * Never deleted: a row is cancelled by status, so what a forecast showed
--     stays explainable. No member DELETE; status open -> realised (a bank
--     row matched it), superseded (a newer row or the invoice replaced it) or
--     cancelled.
--   * One amount, always positive, with its direction; SEK only in v1
--     (currency conversion is not part of the forecast yet).
--   * Same company: an invoice, supplier invoice, bank transaction or
--     dimension value a row points at belongs to the row's company
--     (cash_forecast_rows_same_company, below). Service-role writers (the v1
--     and MCP doors) bypass RLS, so the database holds this, not the API.

CREATE TABLE public.cash_forecast_rows (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  expected_date          date NOT NULL,
  amount                 numeric(15, 2) NOT NULL CHECK (amount > 0),
  direction              text NOT NULL CHECK (direction IN ('in', 'out')),
  currency               text NOT NULL DEFAULT 'SEK' CHECK (currency = 'SEK'),
  category               text NOT NULL CHECK (category IN ('revenue', 'payroll', 'tax', 'rent', 'loan', 'other')),
  -- Who wrote it: a person in the app, the v1 API, an MCP client, or a
  -- property management system feeding bookings through the API.
  source                 text NOT NULL CHECK (source IN ('manual', 'api', 'mcp', 'pms')),
  external_source        text CHECK (external_source IS NULL OR char_length(external_source) BETWEEN 1 AND 100),
  external_id            text CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 200),
  confidence             text NOT NULL DEFAULT 'likely' CHECK (confidence IN ('firm', 'likely', 'possible')),
  dimension_value_id     uuid REFERENCES public.dimension_values(id) ON DELETE SET NULL,
  -- The invoice the row expects: once it exists, the invoice counts and the
  -- row does not (the forecast counts each krona once).
  invoice_id             uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  supplier_invoice_id    uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'realised', 'superseded', 'cancelled')),
  -- The bank row that realised it, set with status realised.
  matched_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  note                   text CHECK (note IS NULL OR char_length(note) <= 500),
  created_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_forecast_rows_external_pair CHECK ((external_source IS NULL) = (external_id IS NULL)),
  CONSTRAINT cash_forecast_rows_one_invoice CHECK (invoice_id IS NULL OR supplier_invoice_id IS NULL),
  CONSTRAINT cash_forecast_rows_matched_only_realised CHECK (matched_transaction_id IS NULL OR status = 'realised'),
  -- NULLs are distinct: rows without an external key never collide.
  CONSTRAINT cash_forecast_rows_external_key UNIQUE (company_id, external_source, external_id)
);

COMMENT ON TABLE public.cash_forecast_rows IS
  'Expected money in or out on a day that the books do not hold yet, for the liquidity forecast (src/lib/forecast). Not bookkeeping: never posted. Cancelled by status, never deleted; upserted by (company_id, external_source, external_id).';
COMMENT ON COLUMN public.cash_forecast_rows.invoice_id IS
  'The customer invoice the row anticipates. Once linked, the forecast counts the invoice and leaves the row out.';
COMMENT ON COLUMN public.cash_forecast_rows.status IS
  'open: counts in the forecast while dated today or later. realised: a bank row matched it. superseded: replaced by a newer row or the invoice. cancelled: withdrawn.';

CREATE INDEX idx_cash_forecast_rows_company_date
  ON public.cash_forecast_rows (company_id, expected_date)
  WHERE status = 'open';
CREATE INDEX idx_cash_forecast_rows_invoice
  ON public.cash_forecast_rows (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_cash_forecast_rows_supplier_invoice
  ON public.cash_forecast_rows (supplier_invoice_id) WHERE supplier_invoice_id IS NOT NULL;
-- One bank transaction realises at most one forecast row, even when two
-- matcher runs overlap: the second link is refused, not counted twice.
CREATE UNIQUE INDEX uq_cash_forecast_rows_matched_transaction
  ON public.cash_forecast_rows (matched_transaction_id) WHERE matched_transaction_id IS NOT NULL;
CREATE INDEX idx_cash_forecast_rows_dimension_value
  ON public.cash_forecast_rows (dimension_value_id) WHERE dimension_value_id IS NOT NULL;

-- =============================================================================
-- Same-company references
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cash_forecast_rows_same_company()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.invoices i WHERE i.id = NEW.invoice_id AND i.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'cash_forecast_rows: invoice % belongs to another company', NEW.invoice_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.supplier_invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.supplier_invoices s WHERE s.id = NEW.supplier_invoice_id AND s.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'cash_forecast_rows: supplier invoice % belongs to another company', NEW.supplier_invoice_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.matched_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id = NEW.matched_transaction_id AND t.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'cash_forecast_rows: transaction % belongs to another company', NEW.matched_transaction_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.dimension_value_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dimension_values d WHERE d.id = NEW.dimension_value_id AND d.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'cash_forecast_rows: dimension value % belongs to another company', NEW.dimension_value_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.cash_forecast_rows_same_company() IS
  'Refuses a cash_forecast_rows row that points at an invoice, supplier invoice, transaction or dimension value of another company.';

CREATE TRIGGER cash_forecast_rows_same_company
  BEFORE INSERT OR UPDATE OF company_id, invoice_id, supplier_invoice_id, matched_transaction_id, dimension_value_id
  ON public.cash_forecast_rows
  FOR EACH ROW EXECUTE FUNCTION public.cash_forecast_rows_same_company();

CREATE TRIGGER set_updated_at_cash_forecast_rows
  BEFORE UPDATE ON public.cash_forecast_rows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Behandlingshistorik: who added, changed or cancelled a forecast row, and when.
CREATE TRIGGER audit_cash_forecast_rows
  AFTER INSERT OR UPDATE OR DELETE ON public.cash_forecast_rows
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- Batch upsert by the outside key
-- =============================================================================

-- One statement per batch: a new (external_source, external_id) inserts a
-- row, a known one updates it while it is open, and a row that is realised,
-- superseded or cancelled is left as it is (the WHERE on the conflict), so a
-- system resending a booking a person cancelled does not bring it back. source
-- and created_by are written on insert only. SECURITY INVOKER: RLS applies to a
-- browser session; the v1 and MCP doors run as service role with the company
-- they resolved. Answers the rows it wrote.
CREATE OR REPLACE FUNCTION public.upsert_cash_forecast_rows(
  p_company_id uuid,
  p_source text,
  p_created_by uuid,
  p_rows jsonb
)
 RETURNS SETOF public.cash_forecast_rows
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  INSERT INTO public.cash_forecast_rows AS r (
    company_id, external_source, external_id, expected_date, amount, direction, category,
    confidence, note, dimension_value_id, invoice_id, supplier_invoice_id, source, created_by
  )
  SELECT p_company_id, x.external_source, x.external_id, x.expected_date, x.amount, x.direction, x.category,
         coalesce(x.confidence, 'likely'), x.note, x.dimension_value_id, x.invoice_id, x.supplier_invoice_id,
         p_source, coalesce(auth.uid(), p_created_by)
    FROM jsonb_to_recordset(p_rows) AS x(
      external_source text, external_id text, expected_date date, amount numeric, direction text,
      category text, confidence text, note text, dimension_value_id uuid, invoice_id uuid, supplier_invoice_id uuid
    )
  ON CONFLICT ON CONSTRAINT cash_forecast_rows_external_key DO UPDATE SET
    expected_date       = EXCLUDED.expected_date,
    amount              = EXCLUDED.amount,
    direction           = EXCLUDED.direction,
    category            = EXCLUDED.category,
    confidence          = EXCLUDED.confidence,
    note                = EXCLUDED.note,
    dimension_value_id  = EXCLUDED.dimension_value_id,
    invoice_id          = EXCLUDED.invoice_id,
    supplier_invoice_id = EXCLUDED.supplier_invoice_id
  WHERE r.status = 'open'
  RETURNING r.*;
$function$;

COMMENT ON FUNCTION public.upsert_cash_forecast_rows(uuid, text, uuid, jsonb) IS
  'Inserts or updates forecast rows by (company_id, external_source, external_id); rows no longer open are left as they are. Answers the rows written.';

REVOKE ALL ON FUNCTION public.upsert_cash_forecast_rows(uuid, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_cash_forecast_rows(uuid, text, uuid, jsonb) TO authenticated, service_role;

-- =============================================================================
-- RLS and grants
-- =============================================================================

ALTER TABLE public.cash_forecast_rows ENABLE ROW LEVEL SECURITY;

-- Members read their companies' rows; a writing member of the active company
-- adds and changes them. No DELETE policy and no DELETE grant: a row is
-- cancelled by status. The company's own deletion cascades.
CREATE POLICY cash_forecast_rows_select ON public.cash_forecast_rows
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY cash_forecast_rows_insert ON public.cash_forecast_rows
  FOR INSERT WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());
CREATE POLICY cash_forecast_rows_update ON public.cash_forecast_rows
  FOR UPDATE USING (company_id = public.current_active_company_id() AND public.current_user_can_write())
  WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());

GRANT SELECT, INSERT, UPDATE ON TABLE public.cash_forecast_rows TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cash_forecast_rows TO service_role;
-- no-grant: anon on public.cash_forecast_rows (company data)

NOTIFY pgrst, 'reload schema';
