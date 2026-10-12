-- Invoice numbers: unique by value, and never below a number the series
-- already has.
--
-- ML 17 kap 24 § p. 2 asks for a löpnummer, from one or more series, that
-- identifies the invoice uniquely, and the series has to let a missing invoice
-- be spotted (swedish-invoice-compliance, references/invoice-rules.md §1).
-- Until now the position of a series was stored twice, as
-- company_settings.next_invoice_number and as the numbers on the invoices, and
-- nothing kept the two in agreement:
--
--   * generate_invoice_number handed out invoice_prefix || LPAD(counter)
--     without looking at the invoices. A counter set onto an imported number
--     failed on idx_invoices_company_invoice_number on every retry (the failed
--     call rolled its own counter step back, so it never moved on), and a
--     counter below an imported series restarted the series under it.
--   * Uniqueness was checked on the text, so '001' was issued next to an
--     imported '1', and an import added '1' next to an issued '001'. Prod held
--     ten such pairs on 2026-10-12.
--
-- From here the invoices decide and the counter is the company's choice of
-- where its series continues:
--
--   1. invoice_number_value_key() reads a number as the text before its last
--      digits plus those digits as a value ('001' and '1' are '1', 'F-007' is
--      'F-7'). guard_invoice_number_value() refuses, on every path that writes
--      invoices.invoice_number (issuing, imports, the API), a number whose key
--      another invoice of the company already has. It refuses with SQLSTATE
--      23505 like idx_invoices_company_invoice_number, so every caller that
--      already answers a taken number (the provider migration's review list,
--      register-booked-invoice) answers this one the same way. It checks only
--      the row being written, so the ten existing pairs stay as they were
--      issued. An exact repeat of the text is still left to the unique index.
--   2. invoice_number_series_position() says where a company's own series
--      stands. The series is invoice_prefix followed by digits, read as a value
--      (PF- followed by digits for proformas). The next number is the first
--      free value from the counter on. The highest number leaves out
--      Accounted's own year-style numbers from before 20260510120000
--      (prefix || year || number, e.g. 2026383 followed by 384): that format
--      ended when the year was dropped, and the series carried on from the
--      number after the year.
--   3. generate_invoice_number skips values already used (a used number is not
--      a gap) and refuses with INVOICE_NUMBER_SERIES_BEHIND (PT409) when a
--      higher number already exists: issuing below it would fill a hole in the
--      series or restart it. The refusal rolls back, so no number is used up.
--      The company says where the series continues, in the settings.
--   4. invoice_number_series_status() answers the same question for the
--      preview (peek_next_invoice_number, the confirm before issuing) and for
--      the settings check of a proposed prefix and next number.
--   5. Proformas get their own counter, next_proforma_number. They drew from
--      next_invoice_number, so every numbered proforma left a hole in the
--      invoice series.
--
-- pg-test: tests/pg/invoice-number-series.pg.test.ts

-- ---------------------------------------------------------------------------
-- 1. The proforma counter
-- ---------------------------------------------------------------------------

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS next_proforma_number integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.company_settings.next_proforma_number IS
  'Next number in the PF- series of proforma invoices. Separate from next_invoice_number so a proforma never takes a number from the invoice series.';

-- A proforma that already has a number keeps it; the new counter starts after
-- the highest one.
UPDATE public.company_settings cs
SET next_proforma_number = p.highest + 1
FROM (
  SELECT company_id, max(substr(invoice_number, 4)::bigint) AS highest
  FROM public.invoices
  WHERE document_type = 'proforma'
    AND invoice_number ~ '^PF-[0-9]{1,9}$'
  GROUP BY company_id
) p
WHERE p.company_id = cs.company_id
  AND p.highest + 1 > cs.next_proforma_number;

-- ---------------------------------------------------------------------------
-- 2. One invoice per number value
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.invoice_number_value_key(p_number text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT pg_catalog.regexp_replace(p_number, '0*([0-9]+)$', '\1')
$function$;

COMMENT ON FUNCTION public.invoice_number_value_key(text) IS
  'An invoice number as the text before its last digits plus those digits without leading zeros: 001 and 1 give 1, F-007 gives F-7. Two numbers with the same key are the same löpnummer.';

CREATE INDEX IF NOT EXISTS idx_invoices_company_number_value_key
  ON public.invoices (company_id, public.invoice_number_value_key(invoice_number))
  WHERE invoice_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_invoice_number_value()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_key text;
  v_taken text;
BEGIN
  IF NEW.invoice_number IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number THEN
    RETURN NEW;
  END IF;

  v_key := public.invoice_number_value_key(NEW.invoice_number);

  -- Writers of one value in one company take turns here, so the second of
  -- two concurrent writes of '1' and '001' sees the first one's row.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('invoice_number_value:' || NEW.company_id::text || ':' || v_key, 0)
  );

  -- An exact repeat of the text is left to idx_invoices_company_invoice_number,
  -- which callers already answer as a unique violation.
  SELECT i.invoice_number INTO v_taken
  FROM public.invoices i
  WHERE i.company_id = NEW.company_id
    AND i.invoice_number IS NOT NULL
    AND public.invoice_number_value_key(i.invoice_number) = v_key
    AND i.invoice_number <> NEW.invoice_number
    AND i.id <> NEW.id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'INVOICE_NUMBER_TAKEN'
      USING ERRCODE = 'unique_violation',
            DETAIL = pg_catalog.json_build_object(
              'invoice_number', NEW.invoice_number,
              'existing_invoice_number', v_taken
            )::text;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_invoice_number_value() IS
  'BEFORE INSERT OR UPDATE OF invoice_number on invoices: refuses (23505, message INVOICE_NUMBER_TAKEN) a number whose invoice_number_value_key another invoice of the company already has, such as 1 next to 001. Checks only the row being written.';

REVOKE ALL ON FUNCTION public.guard_invoice_number_value() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invoices_number_value_unique ON public.invoices;
CREATE TRIGGER trg_invoices_number_value_unique
  BEFORE INSERT OR UPDATE OF invoice_number ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_number_value();

-- ---------------------------------------------------------------------------
-- 3. Where a series stands
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.invoice_number_series_position(
  p_company_id uuid,
  p_prefix text,
  p_counter bigint,
  p_proforma boolean
)
RETURNS TABLE (next_value bigint, highest_value bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  WITH series AS (
    SELECT
      substr(i.invoice_number, length(p_prefix) + 1)::numeric AS v,
      -- Accounted's own year-style numbers (20260510120000 dropped the
      -- year): the last one in prod was issued 2026-05-09.
      (i.created_at < timestamptz '2026-05-11 00:00:00+00'
        AND substr(i.invoice_number, length(p_prefix) + 1) ~ '^20[0-9]{2}[0-9]{3,}$') AS closed
    FROM public.invoices i
    WHERE i.company_id = p_company_id
      AND i.invoice_number IS NOT NULL
      AND CASE
            WHEN p_proforma THEN i.document_type = 'proforma'
            ELSE COALESCE(i.document_type, 'invoice') = 'invoice'
          END
      AND starts_with(i.invoice_number, p_prefix)
      AND substr(i.invoice_number, length(p_prefix) + 1) ~ '^[0-9]{1,15}$'
  ),
  used AS (
    SELECT DISTINCT v FROM series WHERE v >= p_counter
  ),
  -- A run of consecutive used values starting at the counter has
  -- v - row_number() = counter - 1 on every row.
  run AS (
    SELECT v, v - row_number() OVER (ORDER BY v) AS grp FROM used
  )
  SELECT
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM used WHERE v = p_counter) THEN p_counter
      ELSE (SELECT max(v) + 1 FROM run WHERE grp = p_counter - 1)::bigint
    END AS next_value,
    (SELECT max(v) FROM series WHERE NOT closed)::bigint AS highest_value
$function$;

COMMENT ON FUNCTION public.invoice_number_series_position(uuid, text, bigint, boolean) IS
  'Where a company''s own invoice series stands for a given prefix and counter: next_value is the first value from the counter on that no invoice uses, highest_value the highest value in the series (Accounted''s own year-style numbers from before 2026-05-11 left out). Internal: called by generate_invoice_number and invoice_number_series_status.';

REVOKE ALL ON FUNCTION public.invoice_number_series_position(uuid, text, bigint, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_number_series_position(uuid, text, bigint, boolean)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Issuing
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_invoice_number(
  p_company_id uuid,
  p_invoice_id uuid,
  p_document_type text DEFAULT 'invoice'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing text;
  v_proforma boolean := COALESCE(p_document_type = 'proforma', false);
  v_prefix text;
  v_counter integer;
  v_next bigint;
  v_highest bigint;
  v_final text;
  v_trusted boolean;
BEGIN
  -- Fail-closed authorization gate, unchanged from 20260901100000: without a
  -- membership row only service_role or a direct non-PostgREST connection
  -- with no auth.uid() is trusted.
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

  SELECT invoice_number INTO v_existing
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found in company %', p_invoice_id, p_company_id;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- The settings row is the company's numbering lock: one issuer at a time.
  SELECT
    CASE WHEN v_proforma THEN 'PF-' ELSE COALESCE(cs.invoice_prefix, '') END,
    CASE WHEN v_proforma THEN cs.next_proforma_number ELSE cs.next_invoice_number END
  INTO v_prefix, v_counter
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id
  FOR UPDATE;

  IF v_counter IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  SELECT pos.next_value, pos.highest_value INTO v_next, v_highest
  FROM public.invoice_number_series_position(p_company_id, v_prefix, v_counter, v_proforma) pos;

  -- A higher number already exists: the next one would land inside or under
  -- the series. Nothing is written, so nothing is used up.
  IF v_highest IS NOT NULL AND v_highest > v_next THEN
    RAISE EXCEPTION 'INVOICE_NUMBER_SERIES_BEHIND'
      USING ERRCODE = 'PT409',
            DETAIL = pg_catalog.json_build_object(
              'prefix', v_prefix,
              'next_invoice_number', v_counter,
              'highest_number', v_highest,
              'first_allowed', v_highest + 1
            )::text;
  END IF;

  IF v_next >= 2147483647 THEN
    RAISE EXCEPTION 'Invoice number series of company % is exhausted', p_company_id;
  END IF;

  v_final := v_prefix || LPAD(v_next::text, GREATEST(3, length(v_next::text)), '0');

  IF v_proforma THEN
    UPDATE public.company_settings
    SET next_proforma_number = v_next + 1, updated_at = now()
    WHERE company_id = p_company_id;
  ELSE
    UPDATE public.company_settings
    SET next_invoice_number = v_next + 1, updated_at = now()
    WHERE company_id = p_company_id;
  END IF;

  UPDATE public.invoices
  SET invoice_number = v_final
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

COMMENT ON FUNCTION public.generate_invoice_number(uuid, uuid, text) IS
  'Allocates and persists the next number of the company''s own series (PF- series for proformas): the first value from the counter on that no invoice uses. Refuses with PT409 INVOICE_NUMBER_SERIES_BEHIND, using up nothing, when the series already has a higher number. Requires the caller to be a member of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

REVOKE EXECUTE ON FUNCTION public.generate_invoice_number(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number(uuid, uuid, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Preview and the settings check
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.invoice_number_series_status(
  p_company_id uuid,
  p_document_type text DEFAULT 'invoice',
  p_prefix text DEFAULT NULL,
  p_next_number integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_proforma boolean := COALESCE(p_document_type = 'proforma', false);
  v_prefix text;
  v_counter integer;
  v_next bigint;
  v_highest bigint;
  v_behind boolean;
  v_trusted boolean;
BEGIN
  -- Same fail-closed rule as generate_invoice_number; see the comment there.
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

  SELECT
    CASE WHEN v_proforma THEN 'PF-' ELSE COALESCE(cs.invoice_prefix, '') END,
    CASE WHEN v_proforma THEN cs.next_proforma_number ELSE cs.next_invoice_number END
  INTO v_prefix, v_counter
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;

  IF NOT FOUND OR v_counter IS NULL THEN
    RETURN NULL;
  END IF;

  -- A proposed prefix or next number (the settings check) is judged in place
  -- of the stored one.
  IF p_prefix IS NOT NULL AND NOT v_proforma THEN
    v_prefix := p_prefix;
  END IF;
  IF p_next_number IS NOT NULL THEN
    v_counter := p_next_number;
  END IF;

  SELECT pos.next_value, pos.highest_value INTO v_next, v_highest
  FROM public.invoice_number_series_position(p_company_id, v_prefix, v_counter, v_proforma) pos;

  v_behind := v_highest IS NOT NULL AND v_highest > v_next;

  RETURN jsonb_build_object(
    'prefix', v_prefix,
    'next_invoice_number', v_counter,
    'next_number', CASE
      WHEN v_behind THEN NULL
      ELSE v_prefix || LPAD(v_next::text, GREATEST(3, length(v_next::text)), '0')
    END,
    'highest_number', v_highest,
    'behind', v_behind,
    'first_allowed', COALESCE(v_highest + 1, 1)
  );
END;
$function$;

COMMENT ON FUNCTION public.invoice_number_series_status(uuid, text, text, integer) IS
  'Where the company''s own invoice series (PF- series for proformas) stands, without writing: next_number is what generate_invoice_number would issue, or null when behind is true (a higher number already exists, first_allowed is the lowest next number that continues the series). p_prefix and p_next_number judge a proposed setting instead of the stored one. Requires the caller to be a member of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

REVOKE EXECUTE ON FUNCTION public.invoice_number_series_status(uuid, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_number_series_status(uuid, text, text, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.peek_next_invoice_number(
  p_company_id uuid,
  p_document_type text DEFAULT 'invoice'
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.invoice_number_series_status(p_company_id, p_document_type) ->> 'next_number'
$function$;

COMMENT ON FUNCTION public.peek_next_invoice_number(uuid, text) IS
  'Previews the next invoice number without consuming it: the number generate_invoice_number would issue, or null when the company has no settings or its series already has a higher number (see invoice_number_series_status). Requires the caller to be a member of p_company_id; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

REVOKE EXECUTE ON FUNCTION public.peek_next_invoice_number(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.peek_next_invoice_number(uuid, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
