-- Offert (quote) as a fourth invoice document type.
--
-- A quote is a customer-facing price proposal. It never books a journal
-- entry, is never a payment request and consumes nothing from the F-series
-- (ML 17 kap 24 § only governs fakturor). It therefore gets:
--
--   * its own number series, company_settings.next_quote_number, allocated
--     at insert by generate_quote_number() exactly like delivery notes.
--     Proformas share the F-series counter (PF-042 leaves F-042 unused);
--     quotes are far more numerous, so that pattern is deliberately NOT
--     copied here.
--   * valid_until: the date the offer expires. Stored next to due_date
--     (NOT NULL on invoices) which mirrors it for quotes so date-ordered
--     readers keep working; valid_until is the authoritative column.
--   * quote_status: open / accepted / declined. "expired" is DERIVED
--     (quote_status = 'open' AND valid_until < today) so no cron is needed
--     and extending valid_until un-expires the quote for free.
--   * quote_decided_at: when accepted/declined was set.
--
-- The lifecycle column `status` keeps meaning draft / sent / cancelled for
-- quotes; the decision lives in quote_status only. Converting an accepted
-- quote creates a fresh invoice with converted_from_id = quote.id; the quote
-- itself is NOT cancelled (unlike proforma conversion).

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_document_type_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_document_type_check
    CHECK (document_type IN ('invoice', 'proforma', 'delivery_note', 'quote'));

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS valid_until date,
  ADD COLUMN IF NOT EXISTS quote_status text,
  ADD COLUMN IF NOT EXISTS quote_decided_at timestamptz;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_quote_status_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_quote_status_check
    CHECK (quote_status IS NULL OR quote_status IN ('open', 'accepted', 'declined'));

-- Exactly quotes carry a quote_status (and vice versa): a quote can never
-- lose its decision column, and no other document type can grow one.
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_quote_columns_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_quote_columns_check
    CHECK ((document_type = 'quote') = (quote_status IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_invoices_quote_open
  ON public.invoices (company_id, valid_until)
  WHERE document_type = 'quote' AND quote_status = 'open';

-- next_quote_number already exists on prod and staging as a nullable
-- integer DEFAULT 1 with no migration file behind it (an orphan from an
-- earlier hand-applied change). Adopt it here: add where missing, then
-- backfill and tighten so the RPC below can never read NULL.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS next_quote_number integer DEFAULT 1;

UPDATE public.company_settings
SET next_quote_number = 1
WHERE next_quote_number IS NULL;

ALTER TABLE public.company_settings
  ALTER COLUMN next_quote_number SET DEFAULT 1,
  ALTER COLUMN next_quote_number SET NOT NULL;

-- Same authorization gate as generate_delivery_note_number
-- (20260901100000_revoke_anon_execute_on_definer_writes.sql): a member of
-- the company, or a trusted service_role / direct connection with no JWT.
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

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
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

REVOKE EXECUTE ON FUNCTION public.generate_quote_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_quote_number(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_quote_number(uuid) IS
  'Allocates the next offert (quote) number OF-nnn for p_company_id from company_settings.next_quote_number. Requires the caller to be a member of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

COMMENT ON COLUMN public.invoices.valid_until IS
  'Quotes only: the date the offer expires. Expiry is derived (quote_status = open AND valid_until < today); nothing writes an expired state.';
COMMENT ON COLUMN public.invoices.quote_status IS
  'Quotes only: open, accepted or declined. NULL for every other document type (enforced by invoices_quote_columns_check).';

NOTIFY pgrst, 'reload schema';
