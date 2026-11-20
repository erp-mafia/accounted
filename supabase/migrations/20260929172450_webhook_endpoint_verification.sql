-- Migration: webhook_endpoint_verification
--
-- ADA CASA 7.1.2 (#3191): a webhook provider verifies that the subscriber
-- controls the callback URL before it delivers events. Accounted does it with
-- a challenge-response handshake (src/lib/webhooks/verification.ts): a signed
-- `webhook.verification` POST carrying a random challenge, which the endpoint
-- answers with 2xx and the JSON body {"challenge": "<the same value>"}.
--
-- The handshake is synchronous: the challenge is generated, sent and compared
-- inside one request, so it is never stored, not even as a hash. This table
-- only records the outcome.
--
-- Columns:
--   verified_at                   NULL until the CURRENT webhook_url passed.
--   verification_grace_ends_at    Existing endpoints only. Until this instant
--                                 an unverified endpoint keeps receiving
--                                 events; set below to 30 days after this
--                                 migration is applied. NULL on every new
--                                 row: a new endpoint verifies first.
--   verification_attempts         Handshake attempts for the current URL.
--   verification_last_attempt_at  When the last attempt started.
--   verification_last_error       Why the last attempt failed (NULL after a pass).
--   verification_next_attempt_at  Next automatic attempt, run by the per-minute
--                                 dispatch cron; NULL = none scheduled.
--
-- An endpoint is deliverable when active, not disabled, and verified_at IS
-- NOT NULL or verification_grace_ends_at > now(). The status the API reports
-- (verified / pending / grace_period / paused) is derived from these
-- timestamps and never stored, so the grace window closes on time without a
-- job flipping state.
--
-- The guard trigger keeps two invariants no write path can bypass:
--   1. A changed webhook_url is a new endpoint: its verification resets and
--      any grace ends, whoever issues the UPDATE.
--   2. Client roles (anon, authenticated) cannot write the verification
--      columns. Since 20260929173432 they hold no INSERT or UPDATE on
--      webhooks at all, so the privilege check refuses them first; this guard
--      is the second layer should that grant ever return, because the RLS
--      policies would then let a company writer mark an endpoint verified
--      without the handshake. Only the service role (the v1 routes and the
--      dispatcher) records outcomes.

ALTER TABLE public.webhooks
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verification_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_last_error text,
  ADD COLUMN IF NOT EXISTS verification_next_attempt_at timestamptz DEFAULT now();

ALTER TABLE public.webhooks
  ADD CONSTRAINT webhooks_verification_attempts_nonnegative
    CHECK (verification_attempts >= 0),
  ADD CONSTRAINT webhooks_verification_last_error_length
    CHECK (verification_last_error IS NULL OR length(verification_last_error) <= 500);

-- Existing endpoints: 30 days of grace, counted from the moment this runs.
-- Their verification_next_attempt_at took the column default (now()) above,
-- so the dispatch cron starts attempting the handshake right away.
UPDATE public.webhooks
   SET verification_grace_ends_at = now() + interval '30 days'
 WHERE verified_at IS NULL
   AND verification_grace_ends_at IS NULL;

-- The cron's lookup of due handshakes.
CREATE INDEX IF NOT EXISTS idx_webhooks_verification_due
  ON public.webhooks (verification_next_attempt_at)
  WHERE verified_at IS NULL AND verification_next_attempt_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.webhooks_verification_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- 1. A new URL is a new endpoint: whatever the statement set, the handshake
  --    starts over and no grace carries across.
  IF TG_OP = 'UPDATE' AND NEW.webhook_url IS DISTINCT FROM OLD.webhook_url THEN
    NEW.verified_at := NULL;
    NEW.verification_grace_ends_at := NULL;
    NEW.verification_attempts := 0;
    NEW.verification_last_attempt_at := NULL;
    NEW.verification_last_error := NULL;
    NEW.verification_next_attempt_at := now();
    RETURN NEW;
  END IF;

  -- 2. Verification state is recorded by the handshake, never by a client.
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.verified_at IS NOT NULL OR NEW.verification_grace_ends_at IS NOT NULL THEN
        RAISE EXCEPTION 'webhook verification state is recorded by the verification handshake, not by clients'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF (NEW.verified_at, NEW.verification_grace_ends_at, NEW.verification_attempts,
           NEW.verification_last_attempt_at, NEW.verification_last_error,
           NEW.verification_next_attempt_at)
          IS DISTINCT FROM
          (OLD.verified_at, OLD.verification_grace_ends_at, OLD.verification_attempts,
           OLD.verification_last_attempt_at, OLD.verification_last_error,
           OLD.verification_next_attempt_at) THEN
      RAISE EXCEPTION 'webhook verification state is recorded by the verification handshake, not by clients'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhooks_verification_guard ON public.webhooks;
CREATE TRIGGER webhooks_verification_guard
  BEFORE INSERT OR UPDATE ON public.webhooks
  FOR EACH ROW EXECUTE FUNCTION public.webhooks_verification_guard();

-- The credential-columns change (20260929173432) moves webhooks to
-- column-level SELECT grants for end users. If that migration is applied
-- before this one, the verification columns would be invisible to sessions;
-- granting them here keeps them readable in either order. While the
-- table-level grant still exists this is a no-op, and a later table-level
-- REVOKE clears it together with the table grant.
GRANT SELECT (
  verified_at,
  verification_grace_ends_at,
  verification_attempts,
  verification_last_attempt_at,
  verification_last_error,
  verification_next_attempt_at
) ON public.webhooks TO authenticated;

NOTIFY pgrst, 'reload schema';
