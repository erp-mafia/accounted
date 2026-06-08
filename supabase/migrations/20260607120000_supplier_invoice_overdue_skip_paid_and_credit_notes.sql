-- Migration: supplier_invoice_overdue_skip_paid_and_credit_notes
--
-- Fix: supplier invoices showing "Förfallen" (overdue) even though
-- "kvar att betala" (remaining_amount) is 0 kr.
--
-- Root cause: update_overdue_supplier_invoices() (the daily pg_cron job from
-- 20260303145744_supplier_invoice_overdue_cron.sql) flipped EVERY row past its
-- due_date whose status was 'registered'/'approved' to 'overdue', without ever
-- looking at the outstanding balance.
--
-- Credit notes (is_credit_note = true) are created with status='registered',
-- remaining_amount=0 and due_date=today (see the supplier-invoice credit
-- routes). A credit note is not a payable — there is nothing to pay and nothing
-- to fall due — but because it sits in 'registered' with a due_date of today,
-- the cron turned it 'overdue' the very next day. The same happens to any
-- regular invoice that was fully paid but left in 'registered'/'approved'.
--
-- Two parts:
--   1. Guard the cron so a row with no outstanding balance, or a credit note,
--      is never marked overdue.
--   2. Backfill the rows already mis-flagged.

-- 1. Guarded cron function ---------------------------------------------------
-- CREATE OR REPLACE rewrites the whole definition, so re-declare the
-- search_path that 20260304191528_set_search_path_on_functions.sql pinned.
CREATE OR REPLACE FUNCTION public.update_overdue_supplier_invoices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE supplier_invoices
  SET status = 'overdue',
      updated_at = NOW()
  WHERE due_date < CURRENT_DATE
    AND status IN ('registered', 'approved')
    -- Nothing left to pay -> cannot be overdue. 0.005 mirrors the
    -- "fully paid" threshold used by the payment/match paths.
    AND remaining_amount > 0.005
    -- Credit notes (kreditfakturor) are not payables.
    AND COALESCE(is_credit_note, false) = false;
END;
$$;

-- 2. Backfill rows already mis-flagged by the old function -------------------
-- Credit notes wrongly flipped to 'overdue' return to 'registered' (their
-- resting state — there is no payment flow that advances a credit note).
UPDATE public.supplier_invoices
SET status = 'registered',
    updated_at = NOW()
WHERE status = 'overdue'
  AND COALESCE(is_credit_note, false) = true;

-- Regular invoices that are fully paid but stuck on 'overdue' are 'paid'.
-- paid_at is only stamped when it was missing, so a real payment timestamp is
-- never overwritten.
UPDATE public.supplier_invoices
SET status = 'paid',
    paid_at = COALESCE(paid_at, NOW()),
    updated_at = NOW()
WHERE status = 'overdue'
  AND COALESCE(is_credit_note, false) = false
  AND remaining_amount <= 0.005;

NOTIFY pgrst, 'reload schema';
