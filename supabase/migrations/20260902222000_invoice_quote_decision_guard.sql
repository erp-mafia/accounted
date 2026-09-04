-- Two quote guards that only the database can hold atomically.
--
-- 1. A quote that has a live converted invoice is locked in 'accepted'. The
--    three decision writers (dashboard route, v1 route, MCP tool) check for
--    a converted invoice and compare-and-set on the decision they read, but
--    a conversion that lands between their read and their write leaves the
--    quote 'accepted' with a live F-invoice, and a writer that read
--    'accepted' before the conversion can still move it to open or declined.
--    A BEFORE UPDATE trigger closes that window: any attempt to leave
--    'accepted' while an active invoice points back via converted_from_id
--    raises with the registry code in the message, which the routes map to
--    409 INVOICE_QUOTE_ALREADY_INVOICED.
--
-- 2. generate_quote_number() gated on membership only, like its siblings.
--    Every caller is a write route, but a viewer holding only the session
--    token could call the SECURITY DEFINER RPC through PostgREST and burn
--    OF-numbers. The gate now also requires a non-viewer role (same test as
--    20260902093000_security_role_gates_membership_and_posting_integrity).

CREATE OR REPLACE FUNCTION public.invoices_quote_decision_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.document_type = 'quote'
     AND OLD.quote_status = 'accepted'
     AND NEW.quote_status IS DISTINCT FROM 'accepted'
     AND EXISTS (
       SELECT 1 FROM public.invoices i
       WHERE i.converted_from_id = OLD.id
         AND i.status <> 'cancelled'
     )
  THEN
    RAISE EXCEPTION 'INVOICE_QUOTE_ALREADY_INVOICED: quote % has a live converted invoice', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_invoices_quote_decision_guard ON public.invoices;
CREATE TRIGGER trg_invoices_quote_decision_guard
  BEFORE UPDATE OF quote_status ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.invoices_quote_decision_guard();

CREATE OR REPLACE FUNCTION public.generate_quote_number(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_number integer;
  v_trusted boolean;
BEGIN
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  -- Member AND allowed to write: a viewer must not consume the series.
  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = p_company_id
      AND cm.role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller may not allocate quote numbers for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.company_settings
  SET next_quote_number = next_quote_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_quote_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  RETURN 'OF-' || LPAD(v_number::text, GREATEST(3, length(v_number::text)), '0');
END;
$function$;

COMMENT ON FUNCTION public.generate_quote_number(uuid) IS
  'Allocates the next offert (quote) number OF-nnn for p_company_id. Requires a non-viewer membership of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

-- 3. Date invariants the trigger maintains, pinned as CHECKs so no direct
--    write can leave a quote without an expiry or with a diverged mirror,
--    and no other document type can carry an expiry.
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_quote_dates_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_quote_dates_check
    CHECK (
      (document_type = 'quote' AND valid_until IS NOT NULL AND due_date = valid_until)
      OR (document_type <> 'quote' AND valid_until IS NULL)
    );

NOTIFY pgrst, 'reload schema';
