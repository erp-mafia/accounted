-- "Lös upp resten nu" posts its one verifikat and marks the months it
-- dissolves in one transaction.
--
-- dissolveScheduleNow (src/lib/bookkeeping/accruals/service.ts) posted one
-- combined verifikat for every pending month of a schedule and then flipped
-- those months pending to posted in a second statement, the gap
-- commit_accrual_installment (20261113020117) closed for a single month.
-- Killed between the two, the combined verifikat stood while every month was
-- still pending, and the posting run booked each due month again. Racing the
-- posting run, the flip took only the months still pending, the count did not
-- match and the combined verifikat was stornoed, but the months it had
-- flipped stayed posted, pointing at a reversed verifikat, and were never
-- booked.
--
-- commit_accrual_dissolution locks the schedule and its pending months and
-- compares them with the months the caller computed its draft from. When the
-- schedule is no longer active, nothing is pending, or the set changed
-- (another run posted a month, a credit cancelled them, a re-plan replaced
-- them) it answers 'not_pending' and writes nothing: the caller cancels its
-- draft, which has no voucher number, and tries again from the new state.
-- Otherwise it draws the voucher number through commit_journal_entry, marks
-- exactly those months posted and the schedule completed. A failure at any
-- step takes the others down with it.
--
-- The schedule row is locked first, as replan_accrual_installments locks it,
-- so a dissolution and a re-plan of one schedule run one after the other;
-- the months' row locks are what a single month's posting waits on.
--
-- SECURITY INVOKER: the caller keeps exactly the rights it had when this was
-- separate statements. The enforcement triggers, the installment
-- immutability trigger and the voucher numbering are untouched.
--
-- pg-test: tests/pg/accrual-installment-commit.pg.test.ts

CREATE OR REPLACE FUNCTION public.commit_accrual_dissolution(
  p_company_id uuid,
  p_schedule_id uuid,
  p_entry_id uuid,
  p_installment_ids uuid[],
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
  v_schedule_status text;
  v_pending_ids uuid[];
  v_pending_count integer;
  v_any_linked boolean;
  v_amount numeric;
  v_draft_debit numeric;
  v_voucher_number integer;
  v_marked integer;
BEGIN
  IF p_installment_ids IS NULL THEN
    RAISE EXCEPTION 'commit_accrual_dissolution: the months the draft was computed from are required'
      USING ERRCODE = '22023';
  END IF;

  -- commit_journal_entry's first lock, before any row of the schedule: every
  -- transaction that holds both took the company first.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT s.status
    INTO v_schedule_status
    FROM public.accrual_schedules s
   WHERE s.id = p_schedule_id
     AND s.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND OR v_schedule_status <> 'active' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::integer;
    RETURN;
  END IF;

  -- Every month still waiting, locked: a single month's posting, a credit
  -- and a re-plan write these rows and wait for this transaction.
  SELECT coalesce(array_agg(locked.id), '{}'::uuid[]),
         count(*)::integer,
         coalesce(bool_or(locked.journal_entry_id IS NOT NULL), false),
         coalesce(sum(locked.amount), 0)
    INTO v_pending_ids, v_pending_count, v_any_linked, v_amount
    FROM (
      SELECT i.id, i.journal_entry_id, i.amount
        FROM public.accrual_schedule_installments i
       WHERE i.schedule_id = p_schedule_id
         AND i.company_id = p_company_id
         AND i.status = 'pending'
       FOR UPDATE
    ) AS locked;

  -- An expected outcome, returned and not raised: nothing has been written.
  -- The months must be exactly the ones the draft's amount was added up from.
  IF v_pending_count = 0
     OR v_any_linked
     OR NOT (v_pending_ids @> p_installment_ids AND v_pending_ids <@ p_installment_ids) THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::integer;
    RETURN;
  END IF;

  -- Pin what this function can post: an accrual draft of this company for
  -- this schedule. Locked from here, so the lines summed below are the lines
  -- posted: a new line (its foreign key takes a lock on this row) and an
  -- edit of the header wait for this transaction. commit_journal_entry takes
  -- the same lock and checks the status again.
  PERFORM 1
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'draft'
     AND je.source_type = 'accrual'
     AND je.source_id = p_schedule_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid accrual draft not found: %', p_entry_id
      USING ERRCODE = '22023';
  END IF;

  -- The verifikat books what the months it marks add up to. The lines are
  -- locked too: an edit or a delete of one waits for this transaction and
  -- then meets a posted verifikat.
  SELECT coalesce(sum(locked.debit_amount), 0)
    INTO v_draft_debit
    FROM (
      SELECT l.debit_amount
        FROM public.journal_entry_lines l
       WHERE l.journal_entry_id = p_entry_id
       FOR UPDATE
    ) AS locked;

  IF abs(v_draft_debit - v_amount) > 0.005 THEN
    RAISE EXCEPTION 'The pending months add up to %, the draft voucher to %',
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
   WHERE id = ANY (v_pending_ids)
     AND company_id = p_company_id
     AND status = 'pending';
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  -- A month that was not marked (a policy or a trigger kept the row as it
  -- was) must not leave the combined voucher posted: raising rolls the
  -- number, and the months that were marked, back too.
  IF v_marked <> v_pending_count THEN
    RAISE EXCEPTION 'Accrual schedule %: % of % months could be marked posted',
      p_schedule_id, v_marked, v_pending_count
      USING ERRCODE = '23514';
  END IF;

  -- Nothing is left to dissolve.
  UPDATE public.accrual_schedules
     SET status = 'completed'
   WHERE id = p_schedule_id
     AND company_id = p_company_id
     AND status = 'active';

  RETURN QUERY SELECT 'posted'::text, v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_accrual_dissolution(
  uuid, uuid, uuid, uuid[], text, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_accrual_dissolution(
  uuid, uuid, uuid, uuid[], text, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_accrual_dissolution(
  uuid, uuid, uuid, uuid[], text, text, text
) IS 'Atomically dissolves the rest of a periodisering: commits the combined accrual draft through commit_journal_entry, marks every pending month of the schedule posted and the schedule completed, under the schedule and month row locks. Answers not_pending, writing nothing, when the pending months are not the ones the draft was computed from.';

NOTIFY pgrst, 'reload schema';
