-- Kontantmetod year-end carry: the link between a carry and its invoice can
-- no longer be lost, duplicated or deleted from under it (issue #3440,
-- review of 20261018131100).
--
-- A carry is live while its per-invoice marker's verifikat is posted AND the
-- invoice's link (invoices.journal_entry_id / supplier_invoices.
-- registration_journal_entry_id) points at it. 20261018131100 guarded the
-- storno of a carry, but three other paths broke that pairing, each
-- reproduced on a database with every migration applied:
--
--   1. delete_last_voucher of a carry's storno restores the carry to
--      'posted' but not the link the storno released. The carry declares its
--      moms in the closed year again while every reader sees the invoice as
--      unlinked, and record_kontantmetod_cutoff_link accepts a second carry:
--      the year-1 moms twice, and guards (d) and (e) silent, so a year-2 cash
--      verifikat books it a third time.
--   2. A member can UPDATE invoices.journal_entry_id directly through
--      PostgREST (authenticated holds UPDATE on invoices), with the same
--      result.
--   3. delete_last_voucher of a settled carry (usually the last voucher of
--      the closed year's series) deletes it: the marker cascades away, the
--      link goes NULL, 1510 stays at minus the cleared amount and the moms
--      declared for the final period disappears from the ledger.
--
-- This migration, additive only:
--   (a) guard_kontantmetod_cutoff_entry refuses a second posted carry marker
--       for an invoice (KONTANTMETOD_CARRY_ALREADY_LIVE), whatever the link
--       says;
--   (b) kontantmetod_carry_on_restore: when a carry goes reversed -> posted
--       (delete_last_voucher deleting its storno), its link is restored, and
--       the restore is refused when the invoice has since been linked
--       elsewhere, carried again, paid or credited
--       (KONTANTMETOD_CARRY_RESTORE_REFUSED);
--   (c) guard_kontantmetod_carry_link: the link of a posted carry is never
--       moved by hand (KONTANTMETOD_CARRY_LINK_LOCKED). The release by (f)
--       still passes: it runs AFTER the carry is 'reversed';
--   (d) guard_kontantmetod_carry_delete: a posted carry is never deleted
--       (KONTANTMETOD_CARRY_DELETE_REFUSED), only stornoed. The sandbox
--       teardown window (20260927220000) is kept: flag plus a per-row
--       company_settings.is_sandbox check;
--   (e) kontantmetod_carry_on_reversal counts only payments dated AFTER the
--       carry as settlements. A payment in the closed year (the part paid
--       before period end that sized a residual or manual carry) cleared
--       nothing the carry booked; counting it made a wrong residual carry
--       impossible to undo, since a rättelse of a carry is refused too.
--
-- The migration-017 enforcement triggers are not touched. Every new trigger
-- refuses or restores the link; none of them writes the journal.
--
-- pg-test: tests/pg/kontantmetod-cutoff-per-invoice.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts

-- =============================================================================
-- (a) The marker guard: one posted carry per invoice
-- =============================================================================
--
-- The body of 20261018131100 with one check added after the link check.
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

    -- At most one posted carry per invoice. The link check above cannot see
    -- a second carry once the link was released or lost (a stornoed carry
    -- restored by delete_last_voucher, a link moved by hand before
    -- 20261018131120), and two posted carries declare the year-1 moms twice.
    IF EXISTS (
      SELECT 1
      FROM public.kontantmetod_cutoff_entries k
      JOIN public.journal_entries e ON e.id = k.journal_entry_id
      WHERE k.kind = NEW.kind
        AND k.journal_entry_id <> NEW.journal_entry_id
        AND e.status = 'posted'
        AND (
          (NEW.kind = 'receivable_invoice' AND k.invoice_id = NEW.invoice_id)
          OR (NEW.kind = 'payable_invoice' AND k.supplier_invoice_id = NEW.supplier_invoice_id)
        )
    ) THEN
      RAISE EXCEPTION 'KONTANTMETOD_CARRY_ALREADY_LIVE'
        USING ERRCODE = '23514',
              DETAIL = format('invoice %s already has a posted kontantmetod year-end carry',
                              COALESCE(NEW.invoice_id, NEW.supplier_invoice_id)),
              HINT = 'An invoice is carried once. Storno the existing carry on its own date before carrying it again.';
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

-- =============================================================================
-- (e) Storno of a carry: only payments after the carry hold it in place
-- =============================================================================
--
-- The body of 20261018131100 with the payment test narrowed to rows dated
-- after the carry (payment_date > OLD.entry_date). The trigger is unchanged
-- and picks up the new body.
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
    EXISTS (
      SELECT 1 FROM public.invoice_payments p
      WHERE p.invoice_id = v_invoice_id
        AND p.payment_date > OLD.entry_date
    )
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
            DETAIL = format('invoice %s has payments after the year end or a booked credit note against carry %s', v_invoice_id, OLD.id);
  END IF;

  IF v_kind = 'payable_invoice' AND (
    EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments p
      WHERE p.supplier_invoice_id = v_supplier_invoice_id
        AND p.payment_date > OLD.entry_date
    )
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
            DETAIL = format('supplier invoice %s has payments after the year end or a booked credit note against carry %s', v_supplier_invoice_id, OLD.id);
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

-- =============================================================================
-- (b) A carry restored to 'posted' takes its link back, or is refused
-- =============================================================================
--
-- delete_last_voucher deletes a storno by first moving the entry it reversed
-- back to 'posted' (reversed_by_id NULL). For a carry that undoes the storno,
-- so the link the storno released (f) must come back with it. Refused when
-- the invoice moved on in the meantime, since the restored carry would then
-- declare the moms a second time:
--   * the invoice is linked to another verifikat, or has another posted
--     carry (it was carried again);
--   * the invoice has any payment row, or a credit note with a posted
--     verifikat. While unlinked, a payment books as a kontantmetod cash
--     payment with its own revenue and moms. A row dated on or before the
--     carry is refused too: it may have changed what the carry should hold.
-- The way out is to leave the storno and run the cut-off again.
--
-- AFTER, as (f): the link write must land only once the status change has.
CREATE OR REPLACE FUNCTION public.kontantmetod_carry_on_restore()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_kind text;
  v_invoice_id uuid;
  v_supplier_invoice_id uuid;
  v_link uuid;
BEGIN
  SELECT k.kind, k.invoice_id, k.supplier_invoice_id
    INTO v_kind, v_invoice_id, v_supplier_invoice_id
  FROM public.kontantmetod_cutoff_entries k
  WHERE k.journal_entry_id = NEW.id
    AND k.kind IN ('receivable_invoice', 'payable_invoice');

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.kontantmetod_cutoff_entries k
    JOIN public.journal_entries e ON e.id = k.journal_entry_id
    WHERE k.kind = v_kind
      AND k.journal_entry_id <> NEW.id
      AND e.status = 'posted'
      AND (
        (v_kind = 'receivable_invoice' AND k.invoice_id = v_invoice_id)
        OR (v_kind = 'payable_invoice' AND k.supplier_invoice_id = v_supplier_invoice_id)
      )
  ) THEN
    RAISE EXCEPTION 'KONTANTMETOD_CARRY_RESTORE_REFUSED'
      USING ERRCODE = '55000',
            DETAIL = format('invoice %s was carried again after carry %s was stornoed',
                            COALESCE(v_invoice_id, v_supplier_invoice_id), NEW.id);
  END IF;

  IF v_kind = 'receivable_invoice' THEN
    IF EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = v_invoice_id)
       OR EXISTS (
         SELECT 1
         FROM public.invoices cn
         JOIN public.journal_entries cje ON cje.id = cn.journal_entry_id
         WHERE cn.credited_invoice_id = v_invoice_id
           AND cje.status = 'posted'
       ) THEN
      RAISE EXCEPTION 'KONTANTMETOD_CARRY_RESTORE_REFUSED'
        USING ERRCODE = '55000',
              DETAIL = format('invoice %s has payments or a booked credit note; restoring carry %s would declare its moms again', v_invoice_id, NEW.id);
    END IF;

    SELECT i.journal_entry_id INTO v_link
    FROM public.invoices i
    WHERE i.id = v_invoice_id
    FOR UPDATE;

    IF v_link IS NULL THEN
      UPDATE public.invoices
      SET journal_entry_id = NEW.id
      WHERE id = v_invoice_id
        AND journal_entry_id IS NULL;
    ELSIF v_link <> NEW.id THEN
      RAISE EXCEPTION 'KONTANTMETOD_CARRY_RESTORE_REFUSED'
        USING ERRCODE = '55000',
              DETAIL = format('invoice %s is linked to verifikat %s, not to carry %s', v_invoice_id, v_link, NEW.id);
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.supplier_invoice_payments p WHERE p.supplier_invoice_id = v_supplier_invoice_id)
       OR EXISTS (
         SELECT 1
         FROM public.supplier_invoices cn
         JOIN public.journal_entries cje ON cje.id = cn.registration_journal_entry_id
         WHERE cn.credited_invoice_id = v_supplier_invoice_id
           AND cje.status = 'posted'
       ) THEN
      RAISE EXCEPTION 'KONTANTMETOD_CARRY_RESTORE_REFUSED'
        USING ERRCODE = '55000',
              DETAIL = format('supplier invoice %s has payments or a booked credit note; restoring carry %s would declare its moms again', v_supplier_invoice_id, NEW.id);
    END IF;

    SELECT si.registration_journal_entry_id INTO v_link
    FROM public.supplier_invoices si
    WHERE si.id = v_supplier_invoice_id
    FOR UPDATE;

    IF v_link IS NULL THEN
      UPDATE public.supplier_invoices
      SET registration_journal_entry_id = NEW.id
      WHERE id = v_supplier_invoice_id
        AND registration_journal_entry_id IS NULL;
    ELSIF v_link <> NEW.id THEN
      RAISE EXCEPTION 'KONTANTMETOD_CARRY_RESTORE_REFUSED'
        USING ERRCODE = '55000',
              DETAIL = format('supplier invoice %s is linked to verifikat %s, not to carry %s', v_supplier_invoice_id, v_link, NEW.id);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kontantmetod_carry_on_restore() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER kontantmetod_carry_on_restore
  AFTER UPDATE OF status ON public.journal_entries
  FOR EACH ROW
  WHEN (OLD.status = 'reversed' AND NEW.status = 'posted')
  EXECUTE FUNCTION public.kontantmetod_carry_on_restore();

-- =============================================================================
-- (c) The link of a posted carry is never moved by hand
-- =============================================================================
--
-- The link routes every payment door, so moving it away from a posted carry
-- turns the invoice back into a plain kontantmetod invoice while the carry
-- still declares its moms. Only the storno releases it ((f), which runs once
-- the carry is 'reversed'); a deleted verifikat's ON DELETE SET NULL passes
-- too, since the deleted row is no longer visible here (and (d) refuses the
-- delete of a posted carry). SECURITY DEFINER so the caller's RLS cannot
-- blind the lookup into letting the move through.
CREATE OR REPLACE FUNCTION public.guard_kontantmetod_carry_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old_link uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    v_old_link := OLD.journal_entry_id;
  ELSE
    v_old_link := OLD.registration_journal_entry_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.kontantmetod_cutoff_entries k
    JOIN public.journal_entries e ON e.id = k.journal_entry_id
    WHERE k.journal_entry_id = v_old_link
      AND e.status = 'posted'
      AND (
        (TG_TABLE_NAME = 'invoices' AND k.kind = 'receivable_invoice' AND k.invoice_id = OLD.id)
        OR (TG_TABLE_NAME = 'supplier_invoices' AND k.kind = 'payable_invoice' AND k.supplier_invoice_id = OLD.id)
      )
  ) THEN
    RAISE EXCEPTION 'KONTANTMETOD_CARRY_LINK_LOCKED'
      USING ERRCODE = '55000',
            DETAIL = format('invoice %s is linked to its kontantmetod year-end carry %s', OLD.id, v_old_link),
            HINT = 'Storno the carry on its own date; that releases the link.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_kontantmetod_carry_link() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_kontantmetod_carry_link
  BEFORE UPDATE OF journal_entry_id ON public.invoices
  FOR EACH ROW
  WHEN (OLD.journal_entry_id IS NOT NULL
        AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id)
  EXECUTE FUNCTION public.guard_kontantmetod_carry_link();

CREATE TRIGGER guard_kontantmetod_carry_link
  BEFORE UPDATE OF registration_journal_entry_id ON public.supplier_invoices
  FOR EACH ROW
  WHEN (OLD.registration_journal_entry_id IS NOT NULL
        AND NEW.registration_journal_entry_id IS DISTINCT FROM OLD.registration_journal_entry_id)
  EXECUTE FUNCTION public.guard_kontantmetod_carry_link();

-- =============================================================================
-- (d) A posted carry is never deleted
-- =============================================================================
--
-- delete_last_voucher (and any other path that sets gnubok.allow_delete)
-- would otherwise delete a carry: the marker cascades, the link goes NULL,
-- the moms declared for the final VAT period leaves the ledger and a year-2
-- clearing is left without its counterpart. A carry is undone by storno
-- only, on its own date and while nothing has settled the invoice since.
-- A reversed carry (with its storno) stays deletable, as any reversed pair.
--
-- Sandbox teardown keeps its window (20260927220000): the flag, set only by
-- cleanup_sandbox_user, re-verified per row against
-- company_settings.is_sandbox, so a real company is never reachable through
-- it.
CREATE OR REPLACE FUNCTION public.guard_kontantmetod_carry_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.kontantmetod_cutoff_entries k
    WHERE k.journal_entry_id = OLD.id
      AND k.kind IN ('receivable_invoice', 'payable_invoice')
  ) THEN
    RETURN OLD;
  END IF;

  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'KONTANTMETOD_CARRY_DELETE_REFUSED'
    USING ERRCODE = '55000',
          DETAIL = format('verifikat %s is a posted kontantmetod year-end carry', OLD.id),
          HINT = 'Storno the carry on its own date instead of deleting it.';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_kontantmetod_carry_delete() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_kontantmetod_carry_delete
  BEFORE DELETE ON public.journal_entries
  FOR EACH ROW
  WHEN (OLD.status = 'posted' AND OLD.source_type = 'year_end')
  EXECUTE FUNCTION public.guard_kontantmetod_carry_delete();

NOTIFY pgrst, 'reload schema';
