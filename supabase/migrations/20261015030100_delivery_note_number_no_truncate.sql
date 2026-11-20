-- Delivery note numbers from 1000 on keep all their digits (GitLab accounted
-- issue #33).
--
-- generate_delivery_note_number returned 'FS-' || year || LPAD(n, 3, '0').
-- Postgres LPAD cuts a string that is longer than the width, so counter 1000
-- gave FS-2026100 and 1234 gave FS-2026123. When note 100 of the same year
-- exists, the insert hits idx_invoices_company_invoice_number and every
-- delivery note from 1000 on fails; otherwise the note is stored under a
-- number that is not its own.
--
-- 20260510130000_invoice_number_no_truncate.sql fixed the same LPAD in
-- generate_invoice_number, and generate_quote_number was written with the
-- fix. This was the last numbering function left with a fixed width.
--
-- The one change: pad to at least three digits, never shorter than the
-- number, GREATEST(3, length(...)) as in the invoice and quote series.
-- Counters 1 to 999 give exactly the numbers they gave before. Everything
-- else (the membership gate, SECURITY DEFINER, search_path, the grants and
-- the comment from 20260901100000) is unchanged; CREATE OR REPLACE keeps the
-- grants and the comment, and they are restated below so this file reads on
-- its own.
--
-- pg-test: tests/pg/delivery-note-number.pg.test.ts

CREATE OR REPLACE FUNCTION public.generate_delivery_note_number(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_number INTEGER;
  v_year TEXT;
  v_trusted boolean;
BEGIN
  -- Same fail-closed rule as generate_invoice_number: only a service_role or
  -- a direct database connection with no auth.uid() is trusted without a
  -- membership in the company.
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
  SET next_delivery_note_number = next_delivery_note_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_delivery_note_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
  -- At least three digits, never cut: LPAD truncates a longer string.
  RETURN 'FS-' || v_year || LPAD(v_number::TEXT, GREATEST(3, length(v_number::TEXT)), '0');
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_delivery_note_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_delivery_note_number(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_delivery_note_number(uuid) IS
  'Allocates the next delivery-note number for p_company_id. Requires the caller to be a member of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';
