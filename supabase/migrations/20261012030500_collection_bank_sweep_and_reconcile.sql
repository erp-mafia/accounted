-- The payment-candidate sweep and the reconcile of cases under collection.
-- pg-test: tests/pg/collection-bank-sweep.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/definer-function-grants.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts,
--          tests/pg/full-archive-coverage.pg.test.ts
--
-- Two guarantees on top of the payment forwarding (20261012030400):
--
-- 1. The sweep (lib/collections/bank-sweep.ts) checks every new inbound bank
--    row, on each bank ingest and nightly, against the invoices the provider
--    is pursuing. A row that may pay one (the OCR or invoice number, the
--    matcher's hint, or the customer's name with an amount up to what is
--    left) pauses the case at the provider and raises an Att göra row, so the
--    provider never sends the next letter for an invoice that may be paid.
--    collection_sweep_hits records each such row per case: once only, so a
--    person who says "this is something else" is not asked again.
--
-- 2. The reconcile (lib/collections/reconcile.ts and
--    reconcile_collection_forwards below) is the guarantee behind the
--    forwarding triggers: every payment and credit note on a case invoice has
--    its forward row, every removed payment is reverted, and once a day the
--    provider's remaining principal is compared with what the books say is
--    owed. A provider that claims more than the books pauses the case; any
--    difference raises an Att göra row until the two agree.

-- =============================================================================
-- 1. collection_sweep_hits
-- =============================================================================
-- A row's life:
--   open       the bank row may pay the invoice and nobody has answered yet
--   booked     the bank row was booked (to this invoice or anything else)
--   dismissed  a person said it pays something else
--   closed     the case closed before anyone answered
-- pause_state says what the sweep did at the provider:
--   pending        about to pause (or the call is in flight)
--   paused         the sweep paused the case
--   already_paused the case was already paused
--   unavailable    the provider offers no pause in the case's current step
--                  (a decision waits for the company, or it is at Kronofogden)
--   failed         the pause call failed; the sync run tries again

CREATE TABLE public.collection_sweep_hits (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The record of a case goes with the case (only a sandbox teardown or a
  -- reservation that never reached the provider removes one).
  case_id uuid NOT NULL REFERENCES public.collection_cases(id) ON DELETE CASCADE,
  -- No foreign key: a bank row removed later leaves the record of why the
  -- case was paused.
  transaction_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('hint', 'reference', 'name')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  transaction_date date NOT NULL,

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'dismissed', 'closed')),
  pause_state text NOT NULL DEFAULT 'pending'
    CHECK (pause_state IN ('pending', 'paused', 'already_paused', 'unavailable', 'failed')),
  pause_attempts integer NOT NULL DEFAULT 0 CHECK (pause_attempts >= 0),
  pause_error text CHECK (pause_error IS NULL OR length(pause_error) <= 200),
  paused_at timestamptz,

  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_sweep_hits_once UNIQUE (case_id, transaction_id),
  CONSTRAINT collection_sweep_hits_resolved_shape CHECK ((status = 'open') = (resolved_at IS NULL))
);

COMMENT ON TABLE public.collection_sweep_hits IS
  'Inbound bank rows that may pay an invoice under collection, found by the payment-candidate sweep, and what was done about each.';

CREATE INDEX collection_sweep_hits_open
  ON public.collection_sweep_hits (company_id, case_id)
  WHERE status = 'open';
CREATE INDEX collection_sweep_hits_pause_due
  ON public.collection_sweep_hits (pause_state)
  WHERE status = 'open' AND pause_state IN ('pending', 'failed');

ALTER TABLE public.collection_sweep_hits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_sweep_hits_select" ON public.collection_sweep_hits
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_sweep_hits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_sweep_hits TO service_role;
-- no-grant: anon on public.collection_sweep_hits (company data)

CREATE TRIGGER collection_sweep_hits_updated_at
  BEFORE UPDATE ON public.collection_sweep_hits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A hit belongs to its case's company and keeps its case and bank row.
CREATE OR REPLACE FUNCTION public.collection_sweep_hit_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.case_id <> OLD.case_id OR NEW.transaction_id <> OLD.transaction_id THEN
      RAISE EXCEPTION 'A collection sweep hit keeps its company, case and bank row'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_cases c WHERE c.id = NEW.case_id AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'A collection sweep hit belongs to its case''s company'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_sweep_hit_shape_guard
  BEFORE INSERT OR UPDATE ON public.collection_sweep_hits
  FOR EACH ROW EXECUTE FUNCTION public.collection_sweep_hit_shape_guard();

-- =============================================================================
-- 2. Reconcile state on the case, the forward and the run
-- =============================================================================

ALTER TABLE public.collection_cases
  -- The provider's remaining principal minus what the books expect it to be
  -- (the customer's share still owed, less reports not yet sent and payments
  -- the provider collected itself). Null while the two agree.
  ADD COLUMN outstanding_mismatch numeric(14,2),
  ADD COLUMN outstanding_expected numeric(14,2),
  ADD COLUMN last_reconciled_at timestamptz;

COMMENT ON COLUMN public.collection_cases.outstanding_mismatch IS
  'Provider remaining principal minus what the books expect at the last reconcile; null while they agree.';

ALTER TABLE public.collection_payment_forwards
  -- A reported payment the provider did not list as received within a day
  -- is sent once more under the same key (reconcile.ts).
  ADD COLUMN resent_at timestamptz;

ALTER TABLE public.collection_sync_state
  -- When the nightly sweep and the daily per-case reconcile last ran.
  ADD COLUMN last_daily_at timestamptz;

-- =============================================================================
-- 3. reconcile_collection_forwards: the guarantee behind the triggers
-- =============================================================================
-- For every registered case that is open, or closed as paid within the last
-- 90 days (the same reach as collection_forward_case_for_invoice):
--   - a payment row on the invoice (not the provider's own collection) with
--     no forward on the case it belongs to gets a pending one;
--   - an issued credit note on the invoice of an open case with no forward
--     gets a pending one;
--   - a reported payment whose row is gone is reverted; one not yet reported
--     is skipped;
--   - a pending credit note that is no longer issued is skipped.
-- Only rows written from ten minutes before the case was reserved count as
-- missing: everything older was recorded before the handover read the
-- invoice and was told to the provider as a prior payment (seeded as
-- forwarded). The ten minutes cover a payment written between that read and
-- the reservation, which nothing else reports.

CREATE OR REPLACE FUNCTION public.reconcile_collection_forwards(p_company_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payments integer := 0;
  v_credits integer := 0;
  v_reverted integer := 0;
  v_skipped integer := 0;
  v_count integer;
BEGIN
  WITH reach AS (
    SELECT c.id AS case_id, c.company_id, c.invoice_id, c.created_at
      FROM public.collection_cases c
     WHERE c.submission_status = 'registered'
       AND (p_company_id IS NULL OR c.company_id = p_company_id)
       AND (c.is_open OR (c.close_reason = 'paid' AND c.closed_at > now() - interval '90 days'))
  ), created AS (
    INSERT INTO public.collection_payment_forwards
      (company_id, case_id, kind, invoice_payment_id, amount, payment_date, status)
    SELECT ip.company_id, r.case_id, 'payment', ip.id, round(ip.amount, 2), ip.payment_date, 'pending'
      FROM reach r
      JOIN public.invoice_payments ip ON ip.invoice_id = r.invoice_id AND ip.company_id = r.company_id
     WHERE ip.source IS DISTINCT FROM 'collections'
       AND round(ip.amount, 2) > 0
       AND ip.created_at > r.created_at - interval '10 minutes'
       AND public.collection_forward_case_for_invoice(ip.company_id, ip.invoice_id, true) = r.case_id
       AND NOT EXISTS (
         SELECT 1 FROM public.collection_payment_forwards f
          WHERE f.kind = 'payment' AND f.case_id = r.case_id AND f.invoice_payment_id = ip.id
       )
    ON CONFLICT (case_id, invoice_payment_id) WHERE kind = 'payment' DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_payments FROM created;

  WITH reach AS (
    SELECT c.id AS case_id, c.company_id, c.invoice_id, c.created_at
      FROM public.collection_cases c
     WHERE c.submission_status = 'registered'
       AND c.is_open
       AND (p_company_id IS NULL OR c.company_id = p_company_id)
  ), created AS (
    INSERT INTO public.collection_payment_forwards
      (company_id, case_id, kind, credit_invoice_id, amount, payment_date, status)
    SELECT cn.company_id, r.case_id, 'credit_note', cn.id,
           round(abs(COALESCE(cn.total, 0)) - abs(COALESCE(cn.deduction_total, 0)), 2),
           COALESCE(cn.invoice_date, (now() AT TIME ZONE 'Europe/Stockholm')::date),
           'pending'
      FROM reach r
      JOIN public.invoices cn ON cn.credited_invoice_id = r.invoice_id AND cn.company_id = r.company_id
     WHERE COALESCE(cn.status, 'draft') NOT IN ('draft', 'cancelled')
       AND round(abs(COALESCE(cn.total, 0)) - abs(COALESCE(cn.deduction_total, 0)), 2) > 0
       AND cn.created_at > r.created_at - interval '10 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM public.collection_payment_forwards f
          WHERE f.kind = 'credit_note' AND f.case_id = r.case_id AND f.credit_invoice_id = cn.id
       )
    ON CONFLICT (case_id, credit_invoice_id) WHERE kind = 'credit_note' DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_credits FROM created;

  -- A reported payment whose row is gone: the provider must drop it.
  UPDATE public.collection_payment_forwards f
     SET status = 'revert_pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
   WHERE f.kind = 'payment'
     AND f.status = 'forwarded'
     AND f.lease_token IS NULL
     AND (p_company_id IS NULL OR f.company_id = p_company_id)
     AND NOT EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.id = f.invoice_payment_id);
  GET DIAGNOSTICS v_reverted = ROW_COUNT;

  -- Not reported yet and gone (the payment row, or the credit note's issue): nothing to send.
  UPDATE public.collection_payment_forwards f
     SET status = 'skipped', next_attempt_at = NULL,
         last_error = CASE WHEN f.kind = 'payment' THEN 'payment_removed' ELSE 'credit_note_withdrawn' END
   WHERE f.status = 'pending'
     AND f.forwarded_at IS NULL
     AND f.lease_token IS NULL
     AND (p_company_id IS NULL OR f.company_id = p_company_id)
     AND (
       (f.kind = 'payment'
         AND NOT EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.id = f.invoice_payment_id))
       OR (f.kind = 'credit_note'
         AND NOT EXISTS (
           SELECT 1 FROM public.invoices cn
            WHERE cn.id = f.credit_invoice_id AND COALESCE(cn.status, 'draft') NOT IN ('draft', 'cancelled')
         ))
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_skipped := v_count;

  RETURN jsonb_build_object(
    'created_payments', v_payments,
    'created_credits', v_credits,
    'reverted', v_reverted,
    'skipped', v_skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_collection_forwards(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_collection_forwards(uuid) TO service_role;

-- =============================================================================
-- 4. Att göra: what the sweep and the reconcile raise
-- =============================================================================
-- Rebuilt from 20261012030400_collection_payment_forwards.sql (the latest
-- definition), adding two reasons, one row per open case:
--   possible_payment      the sweep paused the case, or a bank row it found
--                         is still unbooked and unanswered.
--                         Done: the case is resumed or closes, and every
--                         bank row it found is booked or answered.
--   outstanding_mismatch  the provider's remaining principal differs from
--                         what the books expect, or the reconcile paused the
--                         case over it.
--                         Done: the next reconcile finds them equal and the
--                         case is not paused over it (resumed or closed).

CREATE OR REPLACE FUNCTION public.collection_attention_case_ids(p_company_id uuid)
RETURNS TABLE (case_id uuid, invoice_id uuid, reason text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.invoice_id,
         CASE WHEN c.submission_status = 'failed' THEN 'submission_failed' ELSE 'sync_error' END
    FROM public.collection_cases c
    JOIN public.invoices i ON i.id = c.invoice_id
   WHERE c.company_id = p_company_id
     AND (
       (c.submission_status = 'failed'
         AND i.status IN ('sent', 'overdue', 'partially_paid')
         AND NOT EXISTS (
           SELECT 1 FROM public.collection_cases n
            WHERE n.invoice_id = c.invoice_id AND n.created_at > c.created_at
         ))
       OR (c.is_open AND c.sync_error IS NOT NULL)
     )
  UNION ALL
  SELECT c.id, c.invoice_id,
         CASE WHEN f.status = 'failed' THEN 'forward_failed' ELSE 'payment_excess' END
    FROM public.collection_payment_forwards f
    JOIN public.collection_cases c ON c.id = f.case_id
   WHERE f.company_id = p_company_id
     AND f.attention_resolved_at IS NULL
     AND (f.status = 'failed' OR (f.status IN ('forwarded', 'skipped') AND f.ignored_amount > 0))
  UNION ALL
  SELECT c.id, c.invoice_id, 'possible_payment'
    FROM public.collection_cases c
   WHERE c.company_id = p_company_id
     AND c.is_open
     AND (
       (c.paused_by_sweep AND c.pause_reason = 'possible_payment')
       OR EXISTS (
         SELECT 1
           FROM public.collection_sweep_hits h
           JOIN public.transactions t ON t.id = h.transaction_id AND t.company_id = h.company_id
          WHERE h.case_id = c.id
            AND h.status = 'open'
            AND t.invoice_id IS NULL
            AND t.supplier_invoice_id IS NULL
            AND t.journal_entry_id IS NULL
            AND NOT COALESCE(t.is_ignored, false)
            AND t.is_business IS DISTINCT FROM false
            AND NOT EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.transaction_id = t.id)
       )
     )
  UNION ALL
  SELECT c.id, c.invoice_id, 'outstanding_mismatch'
    FROM public.collection_cases c
   WHERE c.company_id = p_company_id
     AND c.is_open
     AND (c.outstanding_mismatch IS NOT NULL
          OR (c.paused_by_sweep AND c.pause_reason = 'outstanding_mismatch'))
$$;

REVOKE ALL ON FUNCTION public.collection_attention_case_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_attention_case_ids(uuid) TO authenticated, service_role;

-- =============================================================================
-- 5. Disconnect: a duty still owed holds the connection
-- =============================================================================
-- Rebuilt from 20261012030200_collection_cases.sql (the latest definition).
-- A closed case with a report or a revert still to send (a payment removed
-- after the provider closed the case as paid reopens the claim there) holds
-- the connection like an open one: disconnecting would strand it.

CREATE OR REPLACE FUNCTION public.collection_obligation_counts(p_company_id uuid)
RETURNS TABLE (open_cases integer, unbooked_collected_payments integer, unbooked_settlements integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT (SELECT count(*)::integer FROM public.collection_cases c
           WHERE c.company_id = p_company_id
             AND c.submission_status IN ('submitted', 'registered')
             AND (
               c.is_open
               OR EXISTS (
                 SELECT 1 FROM public.collection_payment_forwards f
                  WHERE f.case_id = c.id AND f.status IN ('pending', 'revert_pending')
               )
             )),
         0,
         0
$$;

REVOKE ALL ON FUNCTION public.collection_obligation_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_obligation_counts(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
