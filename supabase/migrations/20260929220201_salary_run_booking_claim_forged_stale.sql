-- accounted#3251 follow-up: a forged claim must not wedge a salary run.
--
-- booking_claim_id and booking_claimed_at are ordinary salary_runs columns, so
-- the existing salary_runs_update policy lets any company writer PATCH them
-- directly instead of going through claim_salary_run_booking(). The claim
-- function only took over a claim older than 15 minutes, which left two
-- forged shapes that could never expire and would block booking for good:
--
--   * booking_claim_id set with booking_claimed_at NULL (NULL < ts is NULL);
--   * booking_claimed_at set in the future.
--
-- The function itself always stamps booking_claimed_at with the database
-- clock, so a genuine claim is never NULL and never ahead of clock_timestamp().
-- Either forged shape is therefore treated as stale and may be taken over,
-- exactly like a claim left behind by a call that died.

CREATE OR REPLACE FUNCTION public.claim_salary_run_booking(p_company_id uuid, p_salary_run_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  UPDATE public.salary_runs
     SET booking_claim_id = gen_random_uuid(),
         booking_claimed_at = clock_timestamp()
   WHERE id = p_salary_run_id
     AND company_id = p_company_id
     AND status = 'paid'
     AND (booking_claim_id IS NULL
          OR booking_claimed_at IS NULL
          OR booking_claimed_at < clock_timestamp() - interval '15 minutes'
          OR booking_claimed_at > clock_timestamp())
  RETURNING booking_claim_id;
$function$;

COMMENT ON FUNCTION public.claim_salary_run_booking(uuid, uuid) IS
  'Claim a paid salary run for booking. Returns the claim token, or NULL when the run is not paid or another live booking holds it. A claim older than 15 minutes, without a timestamp, or stamped in the future is stale and is taken over (accounted#3251).';

REVOKE ALL ON FUNCTION public.claim_salary_run_booking(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_salary_run_booking(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
