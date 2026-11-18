-- A periodisering month reaches the books at most once: the verifikat and
-- the month's own row are posted in one transaction.
--
-- postDueInstallments (src/lib/bookkeeping/accruals/service.ts: the daily
-- cron, Bokför förfallna and the catch-up at creation) committed the month's
-- verifikat and then flipped accrual_schedule_installments pending to posted
-- in a second statement. A run killed between the two left a posted verifikat
-- no month points at and the month still pending, so the next run booked the
-- same month again. Two overlapping runs both posted, and the one whose flip
-- matched nothing stornoed its own verifikat (two numbers for nothing, and a
-- standing duplicate when that storno failed). Every posted unreversed
-- periodiseringsverifikat was pointed at by a month when this was written,
-- so nothing has been booked twice yet and nothing is repaired here; this
-- closes the gap.
--
-- commit_accrual_installment is the shape of commit_asset_depreciation
-- (20260920190200, the same gap on the anläggningsregister): it locks the
-- month's row, answers 'not_pending' when the month is no longer waiting
-- (another run posted it, a credit cancelled it, a re-plan removed it), and
-- otherwise draws the voucher number through commit_journal_entry and marks
-- the month posted. Nothing is written for a refusal, and a failure at either
-- step takes the other down with it, so no number is drawn without a month
-- pointing at its verifikat. cancelSchedules and replan_accrual_installments
-- write the same row, so they wait for this transaction and then see the
-- month as posted.
--
-- SECURITY INVOKER: the caller keeps exactly the rights it had when this was
-- two statements (the installment policies, the company-writer gate, and
-- commit_journal_entry's own guard). The enforcement triggers, the
-- installment immutability trigger and the voucher numbering are untouched.
--
-- pg-test: tests/pg/accrual-installment-commit.pg.test.ts

CREATE OR REPLACE FUNCTION public.commit_accrual_installment(
  p_company_id uuid,
  p_installment_id uuid,
  p_entry_id uuid,
  p_commit_method text DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(outcome text, voucher_number integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_schedule_id uuid;
  v_status text;
  v_linked_entry_id uuid;
  v_amount numeric;
  v_draft_debit numeric;
  v_voucher_number integer;
BEGIN
  -- commit_journal_entry's first lock, taken before the month's row: every
  -- transaction that holds both took the company first, so two of them
  -- cannot wait on each other.
  PERFORM public.lock_cash_account_company(p_company_id);

  -- The month's row is what two posting runs, a credit and a re-plan
  -- serialise on. Whoever comes second reads it after the first committed.
  SELECT i.schedule_id, i.status, i.journal_entry_id, i.amount
    INTO v_schedule_id, v_status, v_linked_entry_id, v_amount
    FROM public.accrual_schedule_installments i
   WHERE i.id = p_installment_id
     AND i.company_id = p_company_id
   FOR UPDATE;

  -- An expected outcome, returned and not raised: nothing has been written,
  -- and the caller cancels its draft, which has no voucher number.
  IF NOT FOUND OR v_status <> 'pending' OR v_linked_entry_id IS NOT NULL THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::integer;
    RETURN;
  END IF;

  -- Pin what this function can post: an accrual draft of this company for
  -- the month's own schedule. Locked from here, so the lines summed below
  -- are the lines posted: a new line (its foreign key takes a lock on this
  -- row) and an edit of the header wait for this transaction.
  -- commit_journal_entry takes the same lock and checks the status again.
  PERFORM 1
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'draft'
     AND je.source_type = 'accrual'
     AND je.source_id = v_schedule_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid accrual draft not found: %', p_entry_id
      USING ERRCODE = '22023';
  END IF;

  -- The function is independently callable, so the amount the month records
  -- must be the amount its verifikat books. The lines are locked too: an edit
  -- or a delete of one waits for this transaction and then meets a posted
  -- verifikat.
  SELECT coalesce(sum(locked.debit_amount), 0)
    INTO v_draft_debit
    FROM (
      SELECT l.debit_amount
        FROM public.journal_entry_lines l
       WHERE l.journal_entry_id = p_entry_id
       FOR UPDATE
    ) AS locked;

  IF abs(v_draft_debit - v_amount) > 0.005 THEN
    RAISE EXCEPTION 'Accrual installment amount % does not match the draft voucher total %',
      v_amount, v_draft_debit
      USING ERRCODE = '23514';
  END IF;

  SELECT committed.voucher_number
    INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      p_entry_id,
      p_commit_method,
      NULL,
      p_actor_type,
      p_actor_label
    ) AS committed;

  UPDATE public.accrual_schedule_installments
     SET status = 'posted',
         journal_entry_id = p_entry_id,
         posted_at = now(),
         last_error = NULL
   WHERE id = p_installment_id
     AND company_id = p_company_id
     AND status = 'pending';

  -- A flip that did not take (a policy or a trigger kept the row as it was)
  -- must not leave the voucher posted: raising rolls the number back too.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accrual installment % could not be marked posted', p_installment_id
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT 'posted'::text, v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_accrual_installment(
  uuid, uuid, uuid, text, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_accrual_installment(
  uuid, uuid, uuid, text, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_accrual_installment(
  uuid, uuid, uuid, text, text, text
) IS 'Atomically posts a periodisering month: commits its accrual draft through commit_journal_entry and marks the accrual_schedule_installments row posted, under the row lock. Answers not_pending, writing nothing, when the month is no longer waiting.';

NOTIFY pgrst, 'reload schema';
