-- accounted#3251: serialize "book this salary run".
--
-- Booking a salary run is check-then-act spread over many PostgREST round
-- trips: read the run as 'paid', post its 1-4 verifikationer through the
-- bookkeeping engine (drafts first, then one commit per voucher), then flip
-- the run to 'booked'. No single transaction covers that sequence, so two
-- concurrent book calls on the same run (two tabs, the dashboard plus MCP, an
-- agent retrying a v1 call after a client timeout) could both read 'paid',
-- both post the full voucher set, and leave the run pointing at the second
-- set with the first one posted and orphaned: lön, arbetsgivaravgifter,
-- semester and pension booked twice. The retry adoption from #3228 only sees
-- vouchers that are already posted, so it covers sequential retries, not
-- simultaneous ones.
--
-- The run row itself becomes the lock. claim_salary_run_booking() takes it
-- with one conditional UPDATE before anything is posted and returns a token;
-- a concurrent caller blocks on the row lock, re-checks the WHERE clause
-- against the committed claim and gets NULL. Only the holder may flip the run
-- to 'booked' (the application filters that UPDATE on status = 'paid' and on
-- the token, and clears the claim in the same statement), and the holder
-- releases the claim when its booking fails so the user can retry at once.
--
-- A claim left behind by a function that died mid-posting expires after 15
-- minutes. That is longer than any hosted function can run (800 s, the
-- platform ceiling the extension and MCP route is set to), so a live holder
-- is never overtaken, and the caller that takes over adopts whatever the
-- dead attempt already posted (createSalaryRunEntries) instead of posting it
-- again. Without an expiry a crash would wedge the run in 'paid' for good.
--
-- SECURITY INVOKER: salary_runs RLS and the company writer-role trigger
-- decide who may claim, exactly as for the status flip itself.

ALTER TABLE public.salary_runs
  ADD COLUMN booking_claim_id uuid,
  ADD COLUMN booking_claimed_at timestamptz;

COMMENT ON COLUMN public.salary_runs.booking_claim_id IS
  'Token of the booking call that currently holds the run (claim_salary_run_booking). Only that call may flip the run to booked; NULL when no booking is in flight.';
COMMENT ON COLUMN public.salary_runs.booking_claimed_at IS
  'When booking_claim_id was taken (database clock). A claim older than 15 minutes belongs to a dead call and may be taken over.';

CREATE FUNCTION public.claim_salary_run_booking(p_company_id uuid, p_salary_run_id uuid)
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
          OR booking_claimed_at < clock_timestamp() - interval '15 minutes')
  RETURNING booking_claim_id;
$function$;

COMMENT ON FUNCTION public.claim_salary_run_booking(uuid, uuid) IS
  'Claim a paid salary run for booking. Returns the claim token, or NULL when the run is not paid or another live booking holds it (accounted#3251).';

REVOKE ALL ON FUNCTION public.claim_salary_run_booking(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_salary_run_booking(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
