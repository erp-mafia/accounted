-- Self-billing on the purchase side (crm#1367).
-- pg-test: tests/pg/supplier-invoice-self-billing.pg.test.ts
--
-- A buyer that issues the invoice in its supplier's name (självfakturering,
-- ML 2023:200 17 kap 15 §) registers it here as a supplier invoice and
-- Accounted makes the document. The customer side already has the received
-- direction (invoices.is_self_billed, 20260613100000); this is the other one.
--
-- What ML 17 kap asks of a self-billing invoice, and where it lives:
--   * a prior agreement (17:15 p.1): suppliers.self_billing_agreement_ref is
--     the default reference on the supplier card, copied onto every invoice
--     (supplier_invoices.self_billing_agreement_ref);
--   * an acceptance procedure (17:15 p.2): the clause printed on the
--     document, company_settings.self_billing_acceptance_text (NULL = the
--     app's built-in text);
--   * the notation "Självfakturering" (17:24 p.12): printed by the app;
--   * a löpnummer in one or more series (17:24 p.2): the self-billing number,
--     the ISSUER's (our) series, separate from the supplier's own numbers and
--     from our F-series. It is assigned here, in the INSERT, by a trigger.
--
-- Why a trigger and not an RPC called before the insert (the quote and
-- delivery-note pattern): an RPC that runs first spends the number even when
-- the insert that follows fails, and a self-billing invoice is a statutory
-- series where an unexplained hole is a compliance finding. The trigger draws
-- the number inside the INSERT statement, so a failed insert rolls the counter
-- back with it. The counter never reuses a number (the document may already be
-- with the seller): it is floored at MAX + 1, never lowered below it.
--
-- The formatted number (prefix + at least three digits) is written to
-- supplier_invoice_number, so every existing reader (lists, payment files,
-- verifikat descriptions, search) shows the invoice's own number; the integer
-- self_billing_number is the series position.
--
-- self_billing_snapshot freezes the parties (seller = the supplier, buyer =
-- the company), the payee, the agreement and the acceptance text as they were
-- when the invoice was issued, so the document renders the same every time.
--
-- An issued self-billing invoice keeps its identity: a guard trigger refuses
-- any change to the flag, the number, the agreement or the snapshot, and a
-- DELETE once its document is archived (a correction is a credit note, which
-- takes its own number from the same series). DELETE before the document
-- exists is the create path's own compensation for a failed registration.

-- The ALTERs and CREATE TRIGGERs take short table locks on three busy tables.
SELECT set_config('lock_timeout', '5s', true);

-- ── 1. Supplier card: the default agreement reference ──────────────────
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS self_billing_agreement_ref text;

ALTER TABLE public.suppliers
  DROP CONSTRAINT IF EXISTS suppliers_self_billing_agreement_ref_check;
ALTER TABLE public.suppliers
  ADD CONSTRAINT suppliers_self_billing_agreement_ref_check
    CHECK (
      self_billing_agreement_ref IS NULL
      OR (self_billing_agreement_ref ~ '\S' AND char_length(self_billing_agreement_ref) <= 128)
    );

COMMENT ON COLUMN public.suppliers.self_billing_agreement_ref IS
  'The self-billing agreement (självfaktureringsavtal, ML 2023:200 17 kap 15 § p.1) with this supplier: the reference a self-billing invoice prints. NULL = no agreement, so no self-billing invoice can be issued to the supplier.';

-- ── 2. Company settings: the series and the acceptance clause ─────────
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS self_billing_prefix text NOT NULL DEFAULT 'SF-',
  ADD COLUMN IF NOT EXISTS next_self_billing_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS self_billing_acceptance_text text;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_self_billing_prefix_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_self_billing_prefix_check
    -- Letters, digits and hyphens, at most 12, never ending in a digit: the
    -- number follows the prefix, so a trailing digit would run into it.
    CHECK (self_billing_prefix ~ '^[A-Za-z0-9-]{0,12}$' AND self_billing_prefix !~ '[0-9]$');

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_next_self_billing_number_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_next_self_billing_number_check
    CHECK (next_self_billing_number >= 1);

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_self_billing_acceptance_text_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_self_billing_acceptance_text_check
    CHECK (self_billing_acceptance_text IS NULL OR char_length(self_billing_acceptance_text) <= 1000);

COMMENT ON COLUMN public.company_settings.self_billing_prefix IS
  'Prefix of the self-billing invoice series (purchase side), default SF-. The number is prefix + at least three digits.';
COMMENT ON COLUMN public.company_settings.next_self_billing_number IS
  'Next number in the self-billing series. assign_self_billing_number() floors it at MAX(self_billing_number) + 1, so it never reuses a number.';
COMMENT ON COLUMN public.company_settings.self_billing_acceptance_text IS
  'The acceptance clause (godkännandeförfarande, ML 2023:200 17 kap 15 § p.2) printed on every self-billing invoice. NULL = the built-in text.';

-- ── 3. Supplier invoices: the self-billing fields ────────────────────
ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS is_self_billed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS self_billing_number integer,
  ADD COLUMN IF NOT EXISTS self_billing_agreement_ref text,
  ADD COLUMN IF NOT EXISTS self_billing_snapshot jsonb;

ALTER TABLE public.supplier_invoices
  DROP CONSTRAINT IF EXISTS supplier_invoices_self_billing_fields;
ALTER TABLE public.supplier_invoices
  ADD CONSTRAINT supplier_invoices_self_billing_fields
    CHECK (
      (
        NOT is_self_billed
        AND self_billing_number IS NULL
        AND self_billing_agreement_ref IS NULL
        AND self_billing_snapshot IS NULL
      )
      OR (
        is_self_billed
        AND self_billing_number IS NOT NULL
        AND self_billing_number >= 1
        AND supplier_invoice_number IS NOT NULL
        AND self_billing_agreement_ref IS NOT NULL
        AND self_billing_agreement_ref ~ '\S'
        AND char_length(self_billing_agreement_ref) <= 128
        AND self_billing_snapshot IS NOT NULL
        AND jsonb_typeof(self_billing_snapshot) = 'object'
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_company_self_billing_number
  ON public.supplier_invoices (company_id, self_billing_number)
  WHERE self_billing_number IS NOT NULL;

COMMENT ON COLUMN public.supplier_invoices.is_self_billed IS
  'A self-billing invoice we issued in the supplier''s name (självfakturering, ML 2023:200 17 kap 15 §). Its number is ours (self_billing_number), its document is made by the app.';
COMMENT ON COLUMN public.supplier_invoices.self_billing_number IS
  'Position in the company''s self-billing series, assigned by assign_self_billing_number() on insert. supplier_invoice_number carries the formatted number.';
COMMENT ON COLUMN public.supplier_invoices.self_billing_agreement_ref IS
  'The self-billing agreement the invoice was issued under (ML 2023:200 17 kap 15 § p.1), printed on the document.';
COMMENT ON COLUMN public.supplier_invoices.self_billing_snapshot IS
  'The parties (seller = the supplier, buyer = the company), payee, agreement and acceptance text frozen when the invoice was issued; the document renders from it.';

-- ── 4. The number, drawn in the INSERT ───────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_self_billing_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_prefix text;
  v_next integer;
  v_floor integer;
  v_number integer;
BEGIN
  IF NEW.self_billing_number IS NOT NULL OR NEW.supplier_invoice_number IS NOT NULL THEN
    RAISE EXCEPTION 'SI_SELF_BILL_NUMBER_ASSIGNED: a self-billing invoice takes its number from the series; do not supply one'
      USING ERRCODE = 'P0001';
  END IF;

  -- The settings row is the series lock: two concurrent inserts queue here.
  SELECT cs.self_billing_prefix, cs.next_self_billing_number
    INTO v_prefix, v_next
    FROM public.company_settings cs
   WHERE cs.company_id = NEW.company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_SELF_BILL_NUMBER_ASSIGNED: company settings not found for company %', NEW.company_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(si.self_billing_number), 0) + 1
    INTO v_floor
    FROM public.supplier_invoices si
   WHERE si.company_id = NEW.company_id
     AND si.self_billing_number IS NOT NULL;

  v_number := GREATEST(v_next, v_floor);

  UPDATE public.company_settings
     SET next_self_billing_number = v_number + 1,
         updated_at = now()
   WHERE company_id = NEW.company_id;

  NEW.self_billing_number := v_number;
  NEW.supplier_invoice_number :=
    v_prefix || LPAD(v_number::text, GREATEST(3, length(v_number::text)), '0');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_self_billing_number() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.assign_self_billing_number() IS
  'BEFORE INSERT on supplier_invoices WHEN is_self_billed: assigns the next number of the company''s self-billing series (prefix + at least three digits) to self_billing_number and supplier_invoice_number. SECURITY DEFINER so a member who cannot write company_settings still advances the counter; the insert itself stays RLS-gated. A failed insert rolls the counter back.';

DROP TRIGGER IF EXISTS assign_self_billing_number ON public.supplier_invoices;
CREATE TRIGGER assign_self_billing_number
  BEFORE INSERT ON public.supplier_invoices
  FOR EACH ROW
  WHEN (NEW.is_self_billed)
  EXECUTE FUNCTION public.assign_self_billing_number();

-- ── 5. An issued self-billing invoice keeps its identity ─────────────
CREATE OR REPLACE FUNCTION public.guard_self_billing_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT OLD.is_self_billed OR OLD.document_id IS NULL THEN
      RETURN OLD;
    END IF;
    -- The sandbox teardown: flag set, running as its owner, and the row's
    -- company still marked as a sandbox (as block_delete_collected_payment).
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
       AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
            WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)
       AND (SELECT pg_catalog.bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
            WHERE cs.company_id = OLD.company_id) IS TRUE THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'SI_SELF_BILL_IMMUTABLE: an issued self-billing invoice cannot be deleted; correct it with a credit note'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT OLD.is_self_billed AND NOT NEW.is_self_billed THEN
    RETURN NEW;
  END IF;
  IF NEW.is_self_billed IS DISTINCT FROM OLD.is_self_billed
     OR NEW.self_billing_number IS DISTINCT FROM OLD.self_billing_number
     OR NEW.supplier_invoice_number IS DISTINCT FROM OLD.supplier_invoice_number
     OR NEW.self_billing_agreement_ref IS DISTINCT FROM OLD.self_billing_agreement_ref
     OR NEW.self_billing_snapshot IS DISTINCT FROM OLD.self_billing_snapshot THEN
    RAISE EXCEPTION 'SI_SELF_BILL_IMMUTABLE: the number, agreement and parties of an issued self-billing invoice cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_self_billing_identity() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_self_billing_identity() IS
  'Refuses a change to the self-billing flag, number, supplier_invoice_number, agreement or snapshot of a self-billing invoice, turning an ordinary invoice into one, and deleting one whose document is archived (the sandbox teardown excepted). Status, payments and document links stay writable.';

DROP TRIGGER IF EXISTS guard_self_billing_identity ON public.supplier_invoices;
CREATE TRIGGER guard_self_billing_identity
  BEFORE UPDATE OR DELETE ON public.supplier_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_self_billing_identity();

NOTIFY pgrst, 'reload schema';
