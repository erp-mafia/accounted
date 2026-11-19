-- A collections payment row a failed settlement left behind may be removed.
-- pg-test: tests/pg/collections-rebook.pg.test.ts
--
-- settleInvoicePayment posts the payment voucher and writes the payment row
-- before it flips the invoice. When that last write loses a race (another
-- payment moved the invoice in between) or fails, it cancels the fresh voucher
-- through cancel_orphaned_entry and removes the row. For a payment the
-- collections provider collected (source 'collections'),
-- block_delete_collected_payment refused that removal: the row stayed,
-- pointing at a cancelled voucher, on an invoice that never reached paid,
-- and the next booking attempt read it as a finished booking (the collected
-- payment marked booked with no voucher in the books).
--
-- Rebuilt from 20261012030300_invoice_payment_provenance.sql with one more
-- case: a row whose voucher is cancelled may be deleted. A posted voucher is
-- only ever cancelled by cancel_orphaned_entry, as the fresh orphan of a
-- failed workflow within minutes of posting, so such a row carries no
-- booking. A row on a posted or reversed voucher stays refused exactly as
-- before, and the rebook window and the sandbox teardown are unchanged.

CREATE OR REPLACE FUNCTION public.block_delete_collected_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF OLD.source IS DISTINCT FROM 'collections' THEN
    RETURN OLD;
  END IF;
  -- The collections rebook service reopens and re-settles the invoice in the
  -- same transaction.
  IF current_setting('gnubok.collections_rebook', true) = 'true' THEN
    RETURN OLD;
  END IF;
  -- The row of a failed settlement: its voucher was cancelled as an orphan,
  -- so nothing in the books rests on the row.
  IF OLD.journal_entry_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.journal_entries je
        WHERE je.id = OLD.journal_entry_id
          AND je.company_id = OLD.company_id
          AND je.status = 'cancelled') THEN
    RETURN OLD;
  END IF;
  -- The sandbox teardown: flag set, running as its owner, and the row's
  -- company still marked as a sandbox.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)
     AND (SELECT pg_catalog.bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'COLLECTED_PAYMENT_DELETE_BLOCKED: a payment the collections provider collected cannot be removed; rebook it through the collections settlement instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;

NOTIFY pgrst, 'reload schema';
