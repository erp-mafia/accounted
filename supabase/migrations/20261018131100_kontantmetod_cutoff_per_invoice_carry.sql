-- Kontantmetoden year end as årsomföring: one year_end verifikat per invoice
-- that is open at period end, linked to the invoice (issue #3440).
--
-- Why this exists: under kontantmetoden (BFL 5 kap 2 §) the invoices that are
-- unpaid at the end of the year are booked at the year end, and under
-- bokslutsmetoden their moms belongs to the final VAT period of that year.
-- The cut-off used to post two aggregate verifikat (kundfordringar,
-- leverantörsskulder) plus a vändning of each on day one of the next year,
-- and the two VAT functions excluded the vändningar (20260914150109). The
-- invoices themselves stayed unlinked, so every payment door kept treating
-- them as never booked: the year-2 payment booked revenue and moms a second
-- time through the cash entry, while the excluded vändning never took the
-- year-1 moms back out. Moms was declared twice, once in each year.
--
-- The replacement is what Fortnox and Visma do (founder decision 2026-10-03):
-- one year_end verifikat per open invoice, dated on period_end, linked
-- through invoices.journal_entry_id / supplier_invoices.
-- registration_journal_entry_id exactly like a faktureringsmetod
-- registration. Every existing payment door already routes on that link, so a
-- carried invoice is cleared against 1510 / 2440 with no moms in year 2, and
-- there is no vändning at all. The vändning rationale in 20260914150109 and
-- 20260813124509 applies to legacy rows only; nothing new is hidden from the
-- VAT functions, which stay unchanged so a filed legacy figure cannot move.
--
-- No data migration: production has never posted a cut-off. Self-hosted
-- legacy rows (the four old kinds) keep validating and keep their figures.
--
-- What this migration adds, all additive:
--   (a) the marker table learns the invoice it carries: invoice_id or
--       supplier_invoice_id, the kinds receivable_invoice / payable_invoice,
--       and a CHECK tying kind and reference together;
--   (b) guard_kontantmetod_cutoff_entry proves a per-invoice marker against
--       the ledger and the invoice, and refuses new vändning markers;
--   (c) record_kontantmetod_cutoff_link writes the marker and the invoice
--       link in one transaction, refusing an invoice that is already linked;
--   (d) guard_kontantmetod_carried_payment_row refuses a payment row dated on
--       or before the carry for a carried invoice (that payment belongs in
--       year 1, so the carry is wrong: storno it first);
--   (e) guard_kontantmetod_carried_cash_entry refuses a kontantmetod cash
--       payment verifikat (revenue and moms) for a carried invoice;
--   (f) kontantmetod_carry_on_reversal releases the link when the carry is
--       stornoed, and refuses a storno that would strand a settlement, a
--       storno dated outside the carry's own VAT period, a rättelse
--       (correctEntry) of a carry, and a cancel of a live carry.
--
-- The migration-017 enforcement triggers are not touched. Every new trigger
-- can only refuse or release the link; none of them writes the journal.
--
-- pg-test: tests/pg/kontantmetod-cutoff-per-invoice.pg.test.ts,
--          tests/pg/kontantmetod-carried-settlement-guard.pg.test.ts,
--          tests/pg/kontantmetod-cutoff-unique.pg.test.ts

-- =============================================================================
-- (a) Marker table: the invoice a per-invoice marker carries
-- =============================================================================

-- ON DELETE RESTRICT: a carried invoice is the underlag of a posted verifikat
-- and is never deleted while its marker exists. The marker itself still goes
-- with its journal entry (ON DELETE CASCADE from 20260914150109), which is how
-- every teardown path (sandbox cleanup, reset_fiscal_year) reaches it before
-- the invoice.
ALTER TABLE public.kontantmetod_cutoff_entries
  ADD COLUMN invoice_id uuid NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  ADD COLUMN supplier_invoice_id uuid NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT;

ALTER TABLE public.kontantmetod_cutoff_entries
  DROP CONSTRAINT kontantmetod_cutoff_entries_kind_check;

ALTER TABLE public.kontantmetod_cutoff_entries
  ADD CONSTRAINT kontantmetod_cutoff_entries_kind_check CHECK (kind IN (
    'receivable', 'receivable_reversal', 'payable', 'payable_reversal',
    'receivable_invoice', 'payable_invoice'
  ));

-- A per-invoice marker names exactly its own side's invoice; a legacy
-- aggregate marker names none.
ALTER TABLE public.kontantmetod_cutoff_entries
  ADD CONSTRAINT kontantmetod_cutoff_entries_invoice_ref_check CHECK (
    (kind = 'receivable_invoice' AND invoice_id IS NOT NULL AND supplier_invoice_id IS NULL)
    OR (kind = 'payable_invoice' AND supplier_invoice_id IS NOT NULL AND invoice_id IS NULL)
    OR (kind IN ('receivable', 'receivable_reversal', 'payable', 'payable_reversal')
        AND invoice_id IS NULL AND supplier_invoice_id IS NULL)
  );

-- Not UNIQUE: a stornoed carry keeps its (immutable) marker, and the re-run
-- that carries the invoice again writes a second one. Serialising live carries
-- is record_kontantmetod_cutoff_link's FOR UPDATE on the invoice row.
CREATE INDEX idx_kontantmetod_cutoff_entries_company_invoice
  ON public.kontantmetod_cutoff_entries (company_id, invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX idx_kontantmetod_cutoff_entries_company_supplier_invoice
  ON public.kontantmetod_cutoff_entries (company_id, supplier_invoice_id)
  WHERE supplier_invoice_id IS NOT NULL;

-- Grants and RLS are unchanged: SELECT and INSERT only, no UPDATE or DELETE
-- for any API role (20260914150109).

COMMENT ON COLUMN public.kontantmetod_cutoff_entries.invoice_id IS
  'The customer invoice a receivable_invoice marker carries over the year end (årsomföring). NULL on every other kind.';
COMMENT ON COLUMN public.kontantmetod_cutoff_entries.supplier_invoice_id IS
  'The supplier invoice a payable_invoice marker carries over the year end (årsomföring). NULL on every other kind.';

-- =============================================================================
-- (b) The marker guard
-- =============================================================================
--
-- Per-invoice kinds are proven for EVERY role, not only the API roles: there
-- is no backfill of them to exempt, and a per-invoice marker changes how every
-- payment door routes the invoice, so it must always be provably a carry:
--   1. the verifikat is a posted source_type 'year_end' entry of the same
--      company, anchored to the period the marker claims;
--   2. it is dated on that period's last day (under bokslutsmetoden the moms
--      of an invoice open at the year end belongs to the closed year's final
--      VAT period);
--   3. the invoice is the same company's, dated on or before period_end, and
--      not linked to any other verifikat;
--   4. the verifikat holds the invoice's receivable (151x debit) or payable
--      (244x credit) leg, the opposite side for a credit note.
--
-- Legacy kinds keep today's rule for the API roles: 'receivable' / 'payable'
-- verbatim (year_end, same company, anchored), and new vändning markers are
-- refused outright. The vändning is retired: a vändning marker is the one
-- thing that takes a verifikat out of a momsdeklaration, and nothing new may
-- be hidden from the VAT functions. Rows already in the table are untouched.
--
-- SECURITY INVOKER, as before (see 20260914150109): the role gate reads
-- current_user, and a member proves a marker only against rows their own RLS
-- lets them see, which fails closed.
CREATE OR REPLACE FUNCTION public.guard_kontantmetod_cutoff_entry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_entry_status text;
  v_entry_date date;
  v_period_end date;
  v_invoice_date date;
  v_credit_note boolean;
  v_link uuid;
BEGIN
  IF NEW.kind IN ('receivable_invoice', 'payable_invoice') THEN
    SELECT e.status, e.entry_date
      INTO v_entry_status, v_entry_date
    FROM public.journal_entries e
    WHERE e.id = NEW.journal_entry_id
      AND e.company_id = NEW.company_id
      AND e.source_type = 'year_end'
      AND e.source_id = NEW.fiscal_period_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'kontantmetod cut-off marker must reference a year_end journal entry in the same company, anchored to the closed period'
        USING ERRCODE = '23514';
    END IF;

    IF v_entry_status IS DISTINCT FROM 'posted' THEN
      RAISE EXCEPTION 'kontantmetod per-invoice carry marker requires a posted verifikat (status %)', v_entry_status
        USING ERRCODE = '23514';
    END IF;

    SELECT fp.period_end INTO v_period_end
    FROM public.fiscal_periods fp
    WHERE fp.id = NEW.fiscal_period_id
      AND fp.company_id = NEW.company_id;

    IF v_period_end IS NULL OR v_entry_date IS DISTINCT FROM v_period_end THEN
      RAISE EXCEPTION 'kontantmetod per-invoice carry must be dated on the closed period''s last day (entry %, period end %)', v_entry_date, v_period_end
        USING ERRCODE = '23514';
    END IF;

    IF NEW.kind = 'receivable_invoice' THEN
      SELECT i.invoice_date,
             (i.credited_invoice_id IS NOT NULL OR COALESCE(i.total, 0) < 0),
             i.journal_entry_id
        INTO v_invoice_date, v_credit_note, v_link
      FROM public.invoices i
      WHERE i.id = NEW.invoice_id
        AND i.company_id = NEW.company_id;
    ELSE
      SELECT si.invoice_date,
             COALESCE(si.is_credit_note, false),
             si.registration_journal_entry_id
        INTO v_invoice_date, v_credit_note, v_link
      FROM public.supplier_invoices si
      WHERE si.id = NEW.supplier_invoice_id
        AND si.company_id = NEW.company_id;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'kontantmetod per-invoice carry must reference an invoice in the same company'
        USING ERRCODE = '23514';
    END IF;

    IF v_invoice_date IS NULL OR v_invoice_date > v_period_end THEN
      RAISE EXCEPTION 'kontantmetod per-invoice carry: the invoice is dated %, after the closed period ending %', v_invoice_date, v_period_end
        USING ERRCODE = '23514';
    END IF;

    IF v_link IS NOT NULL AND v_link <> NEW.journal_entry_id THEN
      RAISE EXCEPTION 'kontantmetod per-invoice carry: the invoice is already linked to verifikat %', v_link
        USING ERRCODE = '23514';
    END IF;

    IF NEW.kind = 'receivable_invoice' AND NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = NEW.journal_entry_id
        AND l.account_number LIKE '151%'
        AND (CASE WHEN v_credit_note THEN l.credit_amount ELSE l.debit_amount END) > 0
    ) THEN
      RAISE EXCEPTION 'kontantmetod per-invoice carry of a customer invoice must hold its 151x % leg', CASE WHEN v_credit_note THEN 'credit' ELSE 'debit' END
        USING ERRCODE = '23514';
    END IF;

    IF NEW.kind = 'payable_invoice' AND NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = NEW.journal_entry_id
        AND l.account_number LIKE '244%'
        AND (CASE WHEN v_credit_note THEN l.debit_amount ELSE l.credit_amount END) > 0
    ) THEN
      RAISE EXCEPTION 'kontantmetod per-invoice carry of a supplier invoice must hold its 244x % leg', CASE WHEN v_credit_note THEN 'debit' ELSE 'credit' END
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF current_user NOT IN ('anon', 'authenticated', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NEW.kind IN ('receivable_reversal', 'payable_reversal') THEN
    RAISE EXCEPTION 'kontantmetod vändning markers are retired: the year-end cut-off is carried per invoice (årsomföring) and nothing new is excluded from the momsdeklaration'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entries e
    WHERE e.id = NEW.journal_entry_id
      AND e.company_id = NEW.company_id
      AND e.source_type = 'year_end'
      AND e.source_id = NEW.fiscal_period_id
  ) THEN
    RAISE EXCEPTION 'kontantmetod cut-off marker must reference a year_end journal entry in the same company, anchored to the closed period'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_kontantmetod_cutoff_entry() FROM PUBLIC, anon, authenticated, service_role;

-- The trigger itself (BEFORE INSERT on kontantmetod_cutoff_entries) is
-- unchanged and picks up the new body.

-- =============================================================================
-- Live carry: the one definition the triggers below share
-- =============================================================================
--
-- A carry is live while its per-invoice marker's verifikat is posted AND the
-- invoice's link still points at it. The link is what routes every payment
-- door, so a marker whose invoice is not linked to it (only possible for a
-- row written outside record_kontantmetod_cutoff_link) carries nothing.
--
-- SECURITY DEFINER so the guards that read it can never be blinded by the
-- caller's RLS into passing a write they exist to refuse; it only reads, and
-- it is not exposed to any API role.
CREATE OR REPLACE FUNCTION public.kontantmetod_live_carry(
  p_invoice_id uuid,
  p_supplier_invoice_id uuid
)
RETURNS TABLE (journal_entry_id uuid, entry_date date, fiscal_period_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT k.journal_entry_id, e.entry_date, k.fiscal_period_id
  FROM public.kontantmetod_cutoff_entries k
  JOIN public.journal_entries e ON e.id = k.journal_entry_id
  WHERE e.status = 'posted'
    AND (
      (p_invoice_id IS NOT NULL
        AND k.kind = 'receivable_invoice'
        AND k.invoice_id = p_invoice_id
        AND EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = k.invoice_id AND i.journal_entry_id = k.journal_entry_id
        ))
      OR
      (p_supplier_invoice_id IS NOT NULL
        AND k.kind = 'payable_invoice'
        AND k.supplier_invoice_id = p_supplier_invoice_id
        AND EXISTS (
          SELECT 1 FROM public.supplier_invoices si
          WHERE si.id = k.supplier_invoice_id
            AND si.registration_journal_entry_id = k.journal_entry_id
        ))
    )
$$;

REVOKE ALL ON FUNCTION public.kontantmetod_live_carry(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.kontantmetod_live_carry(uuid, uuid) IS
  'The live kontantmetod year-end carry of an invoice (customer or supplier): its per-invoice marker''s verifikat is posted and the invoice link points at it. Internal to the carry guards; not exposed to API roles.';

-- =============================================================================
-- (c) record_kontantmetod_cutoff_link: the marker and the link, atomically
-- =============================================================================
--
-- Called by the cut-off writer right after it posted the carry verifikat
-- through the engine. The invoice row is locked FOR UPDATE, so two cut-offs
-- racing for the same invoice serialise here: the loser finds the link set,
-- gets CUTOFF_INVOICE_ALREADY_LINKED and stornoes its own verifikat on
-- period_end, which leaves a visible net-zero pair and no voucher gap.
--
-- The marker INSERT runs the guard above, so a call that names a verifikat
-- that is not a valid carry of this invoice raises and writes nothing.
--
-- SECURITY INVOKER: the caller's RLS and grants decide, exactly as for the
-- writer's own journal INSERT (the marker INSERT policy is the journal's).
CREATE OR REPLACE FUNCTION public.record_kontantmetod_cutoff_link(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_journal_entry_id uuid,
  p_invoice_id uuid DEFAULT NULL,
  p_supplier_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_linked uuid;
  v_marker_id uuid;
  v_kind text;
  v_rows integer;
BEGIN
  IF (p_invoice_id IS NULL) = (p_supplier_invoice_id IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUTOFF_LINK_INVALID_INPUT');
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    v_kind := 'receivable_invoice';
    SELECT i.journal_entry_id INTO v_linked
    FROM public.invoices i
    WHERE i.id = p_invoice_id
      AND i.company_id = p_company_id
    FOR UPDATE;
  ELSE
    v_kind := 'payable_invoice';
    SELECT si.registration_journal_entry_id INTO v_linked
    FROM public.supplier_invoices si
    WHERE si.id = p_supplier_invoice_id
      AND si.company_id = p_company_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUTOFF_INVOICE_NOT_FOUND');
  END IF;

  IF v_linked IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CUTOFF_INVOICE_ALREADY_LINKED',
      'details', jsonb_build_object('journal_entry_id', v_linked)
    );
  END IF;

  INSERT INTO public.kontantmetod_cutoff_entries
    (company_id, fiscal_period_id, kind, journal_entry_id, invoice_id, supplier_invoice_id)
  VALUES
    (p_company_id, p_fiscal_period_id, v_kind, p_journal_entry_id, p_invoice_id, p_supplier_invoice_id)
  RETURNING id INTO v_marker_id;

  IF p_invoice_id IS NOT NULL THEN
    UPDATE public.invoices
    SET journal_entry_id = p_journal_entry_id
    WHERE id = p_invoice_id
      AND company_id = p_company_id
      AND journal_entry_id IS NULL;
  ELSE
    UPDATE public.supplier_invoices
    SET registration_journal_entry_id = p_journal_entry_id
    WHERE id = p_supplier_invoice_id
      AND company_id = p_company_id
      AND registration_journal_entry_id IS NULL;
  END IF;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- The row was locked and unlinked above, so this is only reachable if a
    -- policy hides the UPDATE. Raise so the marker goes with it.
    RAISE EXCEPTION 'record_kontantmetod_cutoff_link: the invoice link could not be written'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'marker_id', v_marker_id,
    'kind', v_kind,
    'journal_entry_id', p_journal_entry_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_kontantmetod_cutoff_link(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_kontantmetod_cutoff_link(uuid, uuid, uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.record_kontantmetod_cutoff_link(uuid, uuid, uuid, uuid, uuid) IS
  'Kontantmetod year-end carry (årsomföring): marks a posted year_end verifikat as the carry of one customer invoice (p_invoice_id) or one supplier invoice (p_supplier_invoice_id) and links the invoice to it (invoices.journal_entry_id / supplier_invoices.registration_journal_entry_id), in one transaction under a FOR UPDATE lock on the invoice. Returns {ok:false, code:CUTOFF_INVOICE_ALREADY_LINKED} when the invoice is already linked; the marker guard raises when the verifikat is not a valid carry of the invoice.';

-- =============================================================================
-- (d) No payment row on or before the carry for a carried invoice
-- =============================================================================
--
-- A carried invoice was open on period_end: that is what the carry asserts.
-- A payment dated on or before period_end contradicts it, and a payment row is
-- what every reader (reskontra, as-of rule, cut-off collector) trusts. Every
-- door that writes a row is covered here at once: the TypeScript row writer,
-- the link RPCs and match_batch_allocate. The way out is a storno of the carry
-- (on period_end), after which the payment books as an ordinary cash payment.
CREATE OR REPLACE FUNCTION public.guard_kontantmetod_carried_payment_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_carry_id uuid;
  v_carry_date date;
BEGIN
  IF TG_TABLE_NAME = 'invoice_payments' THEN
    SELECT c.journal_entry_id, c.entry_date INTO v_carry_id, v_carry_date
    FROM public.kontantmetod_live_carry(NEW.invoice_id, NULL) c
    ORDER BY c.entry_date DESC
    LIMIT 1;
  ELSE
    SELECT c.journal_entry_id, c.entry_date INTO v_carry_id, v_carry_date
    FROM public.kontantmetod_live_carry(NULL, NEW.supplier_invoice_id) c
    ORDER BY c.entry_date DESC
    LIMIT 1;
  END IF;

  IF v_carry_id IS NOT NULL AND NEW.payment_date <= v_carry_date THEN
    RAISE EXCEPTION 'KONTANTMETOD_CARRIED_PAYMENT_BEFORE_CUTOFF'
      USING ERRCODE = '23514',
            DETAIL = format('payment_date %s is on or before the kontantmetod year-end carry %s dated %s',
                            NEW.payment_date, v_carry_id, v_carry_date),
            HINT = 'The invoice was carried as unpaid at the year end. Storno the carry verifikat on its own date first, then book the payment.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_kontantmetod_carried_payment_row() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_kontantmetod_carried_payment_row
  BEFORE INSERT OR UPDATE OF payment_date, invoice_id ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_kontantmetod_carried_payment_row();

CREATE TRIGGER guard_kontantmetod_carried_payment_row
  BEFORE INSERT OR UPDATE OF payment_date, supplier_invoice_id ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_kontantmetod_carried_payment_row();

-- =============================================================================
-- (e) No kontantmetod cash payment verifikat for a carried invoice
-- =============================================================================
--
-- invoice_cash_payment / supplier_invoice_cash_payment book revenue or cost
-- and moms at payment. For a carried invoice both were booked by the carry,
-- so such a verifikat declares the moms a second time, whatever its date. The
-- doors choose the clearing shape from the link already; this is the backstop
-- for a race or a future door. Shape: guard_bank_booking_context
-- (20260921173226), a BEFORE trigger that only refuses.
CREATE OR REPLACE FUNCTION public.guard_kontantmetod_carried_cash_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_carry_id uuid;
BEGIN
  -- Only the transition into 'posted' (or a posted INSERT) is checked.
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RETURN NEW;
  END IF;
  IF NEW.source_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.source_type = 'invoice_cash_payment' THEN
    SELECT c.journal_entry_id INTO v_carry_id
    FROM public.kontantmetod_live_carry(NEW.source_id, NULL) c
    LIMIT 1;
  ELSE
    SELECT c.journal_entry_id INTO v_carry_id
    FROM public.kontantmetod_live_carry(NULL, NEW.source_id) c
    LIMIT 1;
  END IF;

  IF v_carry_id IS NOT NULL THEN
    RAISE EXCEPTION 'KONTANTMETOD_CARRIED_INVOICE_CASH_ENTRY'
      USING ERRCODE = '23514',
            DETAIL = format('invoice %s is carried over the year end by verifikat %s', NEW.source_id, v_carry_id),
            HINT = 'A carried invoice is settled against 1510 / 2440 with no moms. Book the payment as a clearing, not as a cash payment.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_kontantmetod_carried_cash_entry() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_kontantmetod_carried_cash_entry
  BEFORE INSERT OR UPDATE OF status ON public.journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'posted'
        AND NEW.source_type IN ('invoice_cash_payment', 'supplier_invoice_cash_payment'))
  EXECUTE FUNCTION public.guard_kontantmetod_carried_cash_entry();

-- =============================================================================
-- (f) Storno of a carry: release the link, or refuse
-- =============================================================================
--
-- reverseEntry posts the storno, then moves the carry posted -> reversed with
-- reversed_by_id. On that move:
--   * refused when a rättelse (correction_of_id = the carry) is posted: a
--     carry is never corrected in place, it is stornoed and the cut-off is run
--     again (correctEntry posts its correction before it marks the original);
--   * refused when the storno is not dated on the carry's own date: the moms
--     the carry declared must come back out of the same VAT period;
--   * refused while the invoice has a payment row, or a credit note with a
--     posted verifikat: those cleared the 1510 / 2440 the carry booked, and
--     would be stranded (KONTANTMETOD_CARRY_HAS_SETTLEMENTS);
--   * otherwise the invoice link is released, so the invoice is a plain
--     kontantmetod invoice again and the readiness check reopens it. The
--     marker stays (immutable) and is no longer live.
-- A posted -> cancelled move of a live carry is refused: only a storno undoes
-- a carry. (cancel_orphaned_entry cancels fresh orphans; a carry becomes one
-- only if record_kontantmetod_cutoff_link failed, and then it has no marker.)
--
-- AFTER, not BEFORE: the release is a write to another table and must happen
-- only once the status change itself has landed. A raise here still aborts
-- the whole statement.
CREATE OR REPLACE FUNCTION public.kontantmetod_carry_on_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_kind text;
  v_invoice_id uuid;
  v_supplier_invoice_id uuid;
  v_reversal_date date;
BEGIN
  SELECT k.kind, k.invoice_id, k.supplier_invoice_id
    INTO v_kind, v_invoice_id, v_supplier_invoice_id
  FROM public.kontantmetod_cutoff_entries k
  WHERE k.journal_entry_id = OLD.id
    AND k.kind IN ('receivable_invoice', 'payable_invoice');

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'KONTANTMETOD_CARRY_CANCEL_REFUSED'
      USING ERRCODE = '55000',
            DETAIL = format('verifikat %s is a kontantmetod year-end carry', OLD.id),
            HINT = 'Storno the carry on its own date instead.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries c
    WHERE c.correction_of_id = OLD.id
      AND c.status = 'posted'
  ) THEN
    RAISE EXCEPTION 'CUTOFF_CARRY_CORRECTION_REFUSED'
      USING ERRCODE = '55000',
            DETAIL = format('verifikat %s is a kontantmetod year-end carry', OLD.id),
            HINT = 'A carry is not corrected: storno it on its own date and run the cut-off again.';
  END IF;

  SELECT r.entry_date INTO v_reversal_date
  FROM public.journal_entries r
  WHERE r.id = NEW.reversed_by_id;

  IF v_reversal_date IS DISTINCT FROM OLD.entry_date THEN
    RAISE EXCEPTION 'CUTOFF_CARRY_REVERSAL_DATE'
      USING ERRCODE = '55000',
            DETAIL = format('the storno of carry %s is dated %s, the carry %s', OLD.id, v_reversal_date, OLD.entry_date),
            HINT = 'Date the storno on the carry''s own date so its moms leaves the same VAT period.';
  END IF;

  IF v_kind = 'receivable_invoice' AND (
    EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = v_invoice_id)
    OR EXISTS (
      SELECT 1
      FROM public.invoices cn
      JOIN public.journal_entries cje ON cje.id = cn.journal_entry_id
      WHERE cn.credited_invoice_id = v_invoice_id
        AND cje.status = 'posted'
    )
  ) THEN
    RAISE EXCEPTION 'KONTANTMETOD_CARRY_HAS_SETTLEMENTS'
      USING ERRCODE = '55000',
            DETAIL = format('invoice %s has payments or a booked credit note against carry %s', v_invoice_id, OLD.id);
  END IF;

  IF v_kind = 'payable_invoice' AND (
    EXISTS (SELECT 1 FROM public.supplier_invoice_payments p WHERE p.supplier_invoice_id = v_supplier_invoice_id)
    OR EXISTS (
      SELECT 1
      FROM public.supplier_invoices cn
      JOIN public.journal_entries cje ON cje.id = cn.registration_journal_entry_id
      WHERE cn.credited_invoice_id = v_supplier_invoice_id
        AND cje.status = 'posted'
    )
  ) THEN
    RAISE EXCEPTION 'KONTANTMETOD_CARRY_HAS_SETTLEMENTS'
      USING ERRCODE = '55000',
            DETAIL = format('supplier invoice %s has payments or a booked credit note against carry %s', v_supplier_invoice_id, OLD.id);
  END IF;

  IF v_kind = 'receivable_invoice' THEN
    UPDATE public.invoices
    SET journal_entry_id = NULL
    WHERE id = v_invoice_id
      AND journal_entry_id = OLD.id;
  ELSE
    UPDATE public.supplier_invoices
    SET registration_journal_entry_id = NULL
    WHERE id = v_supplier_invoice_id
      AND registration_journal_entry_id = OLD.id;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kontantmetod_carry_on_reversal() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER kontantmetod_carry_on_reversal
  AFTER UPDATE OF status ON public.journal_entries
  FOR EACH ROW
  WHEN (OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled'))
  EXECUTE FUNCTION public.kontantmetod_carry_on_reversal();

NOTIFY pgrst, 'reload schema';
