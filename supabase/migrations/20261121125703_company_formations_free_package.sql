-- A formation is sent in and set up without a payment: only a formation
-- with status 'paid' must carry its payment time.

ALTER TABLE public.company_formations
  DROP CONSTRAINT company_formations_paid_has_time;

ALTER TABLE public.company_formations
  ADD CONSTRAINT company_formations_paid_has_time
    CHECK (status <> 'paid' OR paid_at IS NOT NULL);
