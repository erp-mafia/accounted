-- Payment row company-consistency triggers (P0 tenant backstop).
--
-- invoice_payments and supplier_invoice_payments are the only two child tables
-- that carry BOTH a parent FK (invoice_id / supplier_invoice_id) and their own
-- company_id column (added by 20260330130000_multi_tenant_company_refactor). A
-- row whose company_id disagrees with its parent's company_id is a tenant-
-- isolation defect: it would surface a foreign tenant's payment in this
-- company's ledger (and vice-versa) and corrupt AR/AP reconciliation. RLS scopes
-- reads/writes by company_id but does NOT cross-check the parent, and the write
-- RPCs always pass a consistent pair — so nothing at the DB layer guarantees the
-- invariant. These BEFORE INSERT/UPDATE triggers make it impossible to persist a
-- mismatched pair regardless of how the row is written (RPC, direct PostgREST,
-- service role, or a future code path).
--
-- (journal_entry_lines, invoice_items and supplier_invoice_items carry a parent
-- FK but NO company_id of their own, so they cannot drift and are out of scope.)
--
-- SECURITY posture: like the sibling enforcement triggers in migration 017, the
-- trigger function is a plain (INVOKER) trigger function — it only reads the
-- parent's company_id via the FK and raises; it needs no elevated privilege.

-- =============================================================================
-- 0. PRE-FLIGHT: fail loudly if any existing row already violates the invariant,
--    rather than arming a trigger over dirty data that can never be updated again.
-- =============================================================================
DO $$
DECLARE
  v_bad_invoice_payments uuid[];
  v_bad_supplier_payments uuid[];
BEGIN
  SELECT array_agg(p.id)
    INTO v_bad_invoice_payments
  FROM public.invoice_payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  WHERE p.company_id IS DISTINCT FROM i.company_id;

  SELECT array_agg(p.id)
    INTO v_bad_supplier_payments
  FROM public.supplier_invoice_payments p
  JOIN public.supplier_invoices si ON si.id = p.supplier_invoice_id
  WHERE p.company_id IS DISTINCT FROM si.company_id;

  IF v_bad_invoice_payments IS NOT NULL OR v_bad_supplier_payments IS NOT NULL THEN
    -- Row ids go to NOTICE (server log, operator-visible at apply time); the
    -- exception itself carries only counts so error pipelines/aggregators do
    -- not ingest identifier dumps (OWASP ASVS V8.2.1 / SOC 2 CC6.1).
    RAISE NOTICE 'mismatched invoice_payments ids: %',
      COALESCE(v_bad_invoice_payments, ARRAY[]::uuid[]);
    RAISE NOTICE 'mismatched supplier_invoice_payments ids: %',
      COALESCE(v_bad_supplier_payments, ARRAY[]::uuid[]);
    RAISE EXCEPTION 'Cannot arm payment company-consistency triggers over dirty data: % invoice_payments and % supplier_invoice_payments row(s) mismatched — see preceding NOTICEs for ids.',
      COALESCE(array_length(v_bad_invoice_payments, 1), 0),
      COALESCE(array_length(v_bad_supplier_payments, 1), 0);
  END IF;
END
$$;

-- =============================================================================
-- 1. Trigger function: assert child.company_id matches the parent's company_id.
--    Parameterized on TG_TABLE_NAME so one function covers both payment tables
--    (mirrors the single-function-per-concern style of migration 017).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_payment_company_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_parent_company_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoice_payments' THEN
    SELECT company_id INTO v_parent_company_id
    FROM public.invoices
    WHERE id = NEW.invoice_id;

    IF v_parent_company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION
        'invoice_payments.company_id (%) does not match invoices.company_id (%) for invoice %',
        NEW.company_id, v_parent_company_id, NEW.invoice_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'supplier_invoice_payments' THEN
    SELECT company_id INTO v_parent_company_id
    FROM public.supplier_invoices
    WHERE id = NEW.supplier_invoice_id;

    IF v_parent_company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION
        'supplier_invoice_payments.company_id (%) does not match supplier_invoices.company_id (%) for supplier invoice %',
        NEW.company_id, v_parent_company_id, NEW.supplier_invoice_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. Wire the trigger to both payment tables. BEFORE INSERT OR UPDATE OF the
--    columns that could break the invariant (company_id and the parent FK).
-- =============================================================================
DROP TRIGGER IF EXISTS enforce_payment_company_consistency ON public.invoice_payments;
CREATE TRIGGER enforce_payment_company_consistency
  BEFORE INSERT OR UPDATE OF company_id, invoice_id ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_company_consistency();

DROP TRIGGER IF EXISTS enforce_payment_company_consistency ON public.supplier_invoice_payments;
CREATE TRIGGER enforce_payment_company_consistency
  BEFORE INSERT OR UPDATE OF company_id, supplier_invoice_id ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_company_consistency();

NOTIFY pgrst, 'reload schema';
