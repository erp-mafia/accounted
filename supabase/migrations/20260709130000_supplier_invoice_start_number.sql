-- Configurable starting number for the supplier-invoice series (ankomstnummer).
--
-- Mirrors next_invoice_number for customer invoices: lets a company continue
-- its leverantorsfaktura numbering from a previous system (e.g. Fortnox) when
-- migrating to Accounted, instead of always restarting the ankomstnummer at 1.
--
-- Design: a start FLOOR, not a consumed counter. get_next_arrival_number keeps
-- its self-healing COALESCE(MAX(arrival_number),0)+1 behavior and floors the
-- result at next_arrival_number via GREATEST. Consequences:
--   * Existing companies default to 1, so MAX+1 is unchanged.
--   * Before the first invoice, the series starts at the configured value.
--   * Once real invoices pass the floor, MAX+1 dominates: the floor can never
--     move the series backwards or collide with the
--     (company_id, arrival_number) unique index.
--
-- The function is also hardened while rewritten (it was SECURITY DEFINER with a
-- mutable search_path, flagged by the DB linter): SET search_path = '', all
-- references schema-qualified, plus an inline membership check mirroring
-- generate_invoice_number. NULL auth.uid() (service role / API-key / cron paths
-- that call this RPC) is trusted through.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS next_arrival_number integer NOT NULL DEFAULT 1;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_next_arrival_number_positive;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_next_arrival_number_positive
  CHECK (next_arrival_number >= 1);

CREATE OR REPLACE FUNCTION public.get_next_arrival_number(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_floor integer;
  v_next integer;
BEGIN
  -- Defense-in-depth: refuse to operate on companies the caller is not a
  -- member of. NULL auth.uid() (service role / API-key / cron) is trusted
  -- through, matching generate_invoice_number.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Configured start floor (defaults to 1 for every company; NULL only if the
  -- settings row is missing, in which case COALESCE keeps the old behavior).
  SELECT COALESCE(next_arrival_number, 1) INTO v_floor
  FROM public.company_settings
  WHERE company_id = p_company_id;

  SELECT GREATEST(COALESCE(MAX(arrival_number), 0) + 1, COALESCE(v_floor, 1))
  INTO v_next
  FROM public.supplier_invoices
  WHERE company_id = p_company_id;

  RETURN v_next;
END;
$function$;

NOTIFY pgrst, 'reload schema';
