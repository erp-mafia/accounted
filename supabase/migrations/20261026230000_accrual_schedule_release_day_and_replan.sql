-- "Ändra periodisering": re-plan the months of an accrual schedule that are
-- not yet posted, and let a deferral book on a chosen day of the month.
--
-- release_day: the day of the month each deferral month dissolves on, 1-31,
-- clamped to the month's last day (31 is the last day of every month). NULL
-- keeps the first of the month, the dating every schedule had before. An
-- upplupen kostnad (an expense schedule on 29xx) or upplupen intäkt (a
-- revenue schedule on 17xx, 20261021002400) books on each month's last day
-- before its invoice and never takes one.
--
-- replan_accrual_installments: replaces the pending months of an active
-- schedule in one transaction. Posted months, their verifikat and the
-- installment immutability trigger are untouched: only rows without a
-- journal entry are deleted. Together with the posted months the new ones
-- must cover the schedule's period exactly once and add up to its total, so
-- a plan computed from a stale read (the posting run booked a month in
-- between) is refused with ACCRUAL_REPLAN_CONFLICT instead of replacing a
-- plan that changed. Called by replanRemainingInstallments in
-- src/lib/bookkeeping/accruals/service.ts.
--
-- pg-test: tests/pg/accrual-schedules.pg.test.ts

ALTER TABLE public.accrual_schedules
  ADD COLUMN IF NOT EXISTS release_day smallint;

ALTER TABLE public.accrual_schedules
  DROP CONSTRAINT IF EXISTS accrual_schedules_release_day_valid;
ALTER TABLE public.accrual_schedules
  ADD CONSTRAINT accrual_schedules_release_day_valid CHECK (
    release_day IS NULL
    OR (
      release_day BETWEEN 1 AND 31
      AND NOT (direction = 'expense' AND balance_account ~ '^29[0-9]{2}$')
      AND NOT (direction = 'revenue' AND balance_account ~ '^17[0-9]{2}$')
    )
  );

COMMENT ON COLUMN public.accrual_schedules.release_day IS
  'Day of the month each deferral month dissolves on (1-31, clamped to the month''s last day); NULL = the first of the month. Never set on an upplupen kostnad (expense on 29xx) or upplupen intäkt (revenue on 17xx).';

CREATE OR REPLACE FUNCTION public.replan_accrual_installments(
  p_company_id uuid,
  p_schedule_id uuid,
  p_user_id uuid,
  p_period_end date,
  p_release_day smallint,
  p_installments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_claims jsonb := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_jwt_role text := COALESCE(
    NULLIF(v_claims ->> 'role', ''),
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    ''
  );
  v_member_role text;
  v_schedule public.accrual_schedules%ROWTYPE;
  v_months integer;
  v_new_count integer;
  v_all_count integer;
  v_distinct_count integer;
  v_first_month date;
  v_last_month date;
  v_total numeric;
BEGIN
  IF v_jwt_role = 'authenticated' THEN
    IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'unauthorized: user attribution does not match caller'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized: authenticated or service role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT cm.role
    INTO v_member_role
    FROM public.company_members cm
    JOIN public.companies company
      ON company.id = cm.company_id
     AND company.archived_at IS NULL
   WHERE cm.company_id = p_company_id
     AND cm.user_id = p_user_id;

  IF v_member_role IS NULL OR v_member_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'unauthorized: caller cannot write to company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- The schedule row serialises re-plans of one schedule.
  SELECT s.*
    INTO v_schedule
    FROM public.accrual_schedules s
   WHERE s.id = p_schedule_id
     AND s.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCRUAL_SCHEDULE_NOT_FOUND';
  END IF;
  IF v_schedule.status <> 'active' THEN
    RAISE EXCEPTION 'ACCRUAL_SCHEDULE_NOT_ACTIVE: %', v_schedule.status;
  END IF;
  IF p_period_end IS NULL OR p_period_end < v_schedule.period_start THEN
    RAISE EXCEPTION 'ACCRUAL_REPLAN_INVALID: the period end precedes the period start';
  END IF;
  IF p_installments IS NULL OR jsonb_typeof(p_installments) <> 'array'
     OR jsonb_array_length(p_installments) = 0 THEN
    RAISE EXCEPTION 'ACCRUAL_REPLAN_INVALID: no months to plan';
  END IF;

  -- A credit cancels the pending months before it stornoes the posted ones:
  -- cancelled months on an active schedule are a credit still settling.
  IF EXISTS (
    SELECT 1 FROM public.accrual_schedule_installments i
     WHERE i.schedule_id = p_schedule_id AND i.status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'ACCRUAL_REPLAN_CONFLICT: the schedule has cancelled months';
  END IF;

  v_first_month := date_trunc('month', v_schedule.period_start)::date;
  v_last_month := date_trunc('month', p_period_end)::date;
  v_months := ((EXTRACT(YEAR FROM v_last_month) - EXTRACT(YEAR FROM v_first_month)) * 12
    + (EXTRACT(MONTH FROM v_last_month) - EXTRACT(MONTH FROM v_first_month)))::integer + 1;
  v_new_count := jsonb_array_length(p_installments);

  -- Posted and new months together: every month of the period exactly once,
  -- adding up to the schedule's total.
  WITH all_months AS (
    SELECT (e ->> 'period_month')::date AS period_month, (e ->> 'amount')::numeric AS amount
      FROM jsonb_array_elements(p_installments) AS e
    UNION ALL
    SELECT i.period_month, i.amount
      FROM public.accrual_schedule_installments i
     WHERE i.schedule_id = p_schedule_id AND i.status = 'posted'
  )
  SELECT count(*), count(DISTINCT period_month), COALESCE(sum(amount), 0)
    INTO v_all_count, v_distinct_count, v_total
    FROM all_months
   WHERE period_month BETWEEN v_first_month AND v_last_month;

  IF v_all_count <> v_months OR v_distinct_count <> v_months
     OR v_total <> v_schedule.total_amount
     OR (SELECT count(*) FROM jsonb_array_elements(p_installments)) + (
          SELECT count(*) FROM public.accrual_schedule_installments i
           WHERE i.schedule_id = p_schedule_id AND i.status = 'posted'
        ) <> v_all_count THEN
    RAISE EXCEPTION 'ACCRUAL_REPLAN_CONFLICT: the months no longer cover the period once or add up to the total';
  END IF;

  DELETE FROM public.accrual_schedule_installments i
   WHERE i.schedule_id = p_schedule_id
     AND i.company_id = p_company_id
     AND i.status = 'pending'
     AND i.journal_entry_id IS NULL;

  INSERT INTO public.accrual_schedule_installments
    (user_id, company_id, schedule_id, period_month, amount, status)
  SELECT v_schedule.user_id, p_company_id, p_schedule_id,
         (e ->> 'period_month')::date, (e ->> 'amount')::numeric, 'pending'
    FROM jsonb_array_elements(p_installments) AS e;

  UPDATE public.accrual_schedules
     SET period_end = p_period_end,
         months = v_months,
         release_day = p_release_day
   WHERE id = p_schedule_id
     AND company_id = p_company_id;

  RETURN jsonb_build_object('months', v_months, 'pending_months', v_new_count);
END;
$$;

REVOKE ALL ON FUNCTION public.replan_accrual_installments(uuid, uuid, uuid, date, smallint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replan_accrual_installments(uuid, uuid, uuid, date, smallint, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
