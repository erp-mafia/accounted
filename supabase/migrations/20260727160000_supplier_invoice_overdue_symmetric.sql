-- Migration: supplier_invoice_overdue_symmetric
--
-- Issue #1206: 'overdue' was a one-way label. update_overdue_supplier_invoices()
-- (the daily pg_cron job from 20260303145744, guarded in 20260607120000) flips
-- 'registered'/'approved' payables past their due date to 'overdue', but
-- nothing ever flipped them back. Extending an unbooked invoice's due date
-- (renegotiated terms, a mistyped date) therefore left it "Förfallen" forever,
-- and until #1204 it could not even be deleted.
--
-- Two parts:
--   1. approved_at: the flip collapses 'registered' and 'approved' into the
--      same 'overdue' row, so the way back needs a separate record of whether
--      the invoice was ever attested. Without it every un-flip would strip an
--      approved invoice of its approval.
--   2. The cron becomes symmetric: a payable whose due date is no longer in
--      the past returns to its resting status.

-- 1. Attest timestamp --------------------------------------------------------
ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN public.supplier_invoices.approved_at IS
  'When the invoice was attested (godkänd). Written by the approve paths; the overdue un-flip reads it to choose between ''registered'' and ''approved''. Workflow marker, not räkenskapsinformation: values on rows updated before 2026-07-27 were backfilled from updated_at (no approval log existed) and are therefore derived, not observed attestation moments. Do not use it as an audit fact for those rows; audit_log holds the actual transitions.';

-- Backfill for rows that currently sit in 'approved': updated_at is the closest
-- available proxy (there is no approval log), and the value only ever decides
-- an un-flip target, never a money field. Rows already ON 'overdue' are
-- deliberately left NULL: whether they were approved before the flip is
-- unknowable, and 'registered' is the safe, re-approvable resting state.
--
-- These backfilled timestamps are derived, not observed: the column comment
-- above says so, and audit_log (via the audit_supplier_invoices trigger) stays
-- the record of what actually happened and when. Nothing reads approved_at as
-- an audit fact; it is a workflow marker for the flip/un-flip decision.
UPDATE public.supplier_invoices
SET approved_at = updated_at
WHERE approved_at IS NULL
  AND status = 'approved';

-- 2. Symmetric cron ----------------------------------------------------------
-- CREATE OR REPLACE rewrites the whole definition, so re-declare the
-- search_path that 20260304191528_set_search_path_on_functions.sql pinned.
CREATE OR REPLACE FUNCTION public.update_overdue_supplier_invoices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Flip. Unchanged from 20260607120000: 0.005 mirrors the "fully paid"
  -- threshold used by the payment/match paths, and credit notes
  -- (kreditfakturor) are not payables.
  UPDATE supplier_invoices
  SET status = 'overdue',
      updated_at = NOW()
  WHERE due_date < CURRENT_DATE
    AND status IN ('registered', 'approved')
    AND remaining_amount > 0.005
    AND COALESCE(is_credit_note, false) = false;

  -- Un-flip: the exact inverse of the predicate above. Once the due date is no
  -- longer in the past the invoice is not overdue, so it returns to the status
  -- the flip collapsed. Fully-paid and credit-note rows stuck on 'overdue' are
  -- left alone here: they were repaired once by the backfill in 20260607120000
  -- and the flip can no longer produce them.
  UPDATE supplier_invoices
  SET status = CASE WHEN approved_at IS NOT NULL THEN 'approved' ELSE 'registered' END,
      updated_at = NOW()
  WHERE status = 'overdue'
    AND due_date >= CURRENT_DATE
    AND remaining_amount > 0.005
    AND COALESCE(is_credit_note, false) = false;
END;
$$;

NOTIFY pgrst, 'reload schema';
