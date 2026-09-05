-- =============================================================================
-- Lifecycle emails: welcome mail after signup
-- =============================================================================
--
-- Backs the welcome email every new confirmed account receives (cron
-- /api/lifecycle-emails/welcome/cron, lib/lifecycle-emails/welcome.ts).
--
-- user_lifecycle_emails is the atomic claim: the cron inserts the row FIRST
-- and only sends when the insert won (23505 = another tick already claimed
-- it), releasing the claim if the provider call fails so the next tick
-- retries. Same mechanism as the skv_kvittens dedup in notification_log
-- (20260712113000). Kept separate from notification_log on purpose: that
-- table is reference-scoped (reference_id uuid NOT NULL, days_before NOT
-- NULL) and carries per-user RLS for the in-app feed, while lifecycle mail is
-- account-scoped, has no reference row and is never read by the browser.
--
-- No PII: user_id + key + timestamps + provider message id. Cascades on user
-- delete so account deletion leaves nothing behind.

CREATE TABLE IF NOT EXISTS public.user_lifecycle_emails (
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_key           text NOT NULL,
  claimed_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  provider            text,
  provider_message_id text,
  PRIMARY KEY (user_id, email_key)
);

COMMENT ON TABLE public.user_lifecycle_emails IS
  'One row per (user, lifecycle email) sent. Insert = atomic claim; sent_at set after the provider accepted the mail. Service-role only.';

ALTER TABLE public.user_lifecycle_emails ENABLE ROW LEVEL SECURITY;

-- Service-role only: no policies, and the default table privileges are
-- revoked from the browser-facing roles so a future policy cannot open it by
-- accident.
REVOKE ALL ON TABLE public.user_lifecycle_emails FROM PUBLIC;
REVOKE ALL ON TABLE public.user_lifecycle_emails FROM anon;
REVOKE ALL ON TABLE public.user_lifecycle_emails FROM authenticated;
GRANT ALL ON TABLE public.user_lifecycle_emails TO service_role;

-- -----------------------------------------------------------------------------
-- Candidates for a lifecycle email
-- -----------------------------------------------------------------------------
--
-- SECURITY DEFINER because it reads auth.users (the only place the confirmed
-- state lives). Execution is service-role only: the cron calls it through
-- createServiceClient(); exposing it to anon or authenticated would leak
-- addresses and names.
--
-- Filters, in order of intent:
--   * confirmed address inside the lookback window (email + Google + BankID
--     signups all end up with email_confirmed_at set)
--   * live account: not soft-deleted in auth, not an anonymous sandbox user,
--     profile not deleted or anonymized
--   * no claim row yet for this key
--   * not an invitee: someone with a pending or accepted company/team
--     invitation on the address joined an existing workspace and was
--     welcomed by the person who invited them. Pending counts too: the
--     acceptance can land minutes after confirmation (select-company retry).

CREATE OR REPLACE FUNCTION public.list_users_awaiting_lifecycle_email(
  p_email_key text,
  p_confirmed_since timestamptz,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  locale text,
  confirmed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    u.id,
    u.email::text,
    p.full_name,
    pref.locale,
    u.email_confirmed_at
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  LEFT JOIN public.user_preferences pref ON pref.user_id = u.id
  WHERE u.email_confirmed_at IS NOT NULL
    AND u.email_confirmed_at >= p_confirmed_since
    AND u.email IS NOT NULL
    AND u.deleted_at IS NULL
    AND COALESCE(u.is_anonymous, false) = false
    AND p.deleted_at IS NULL
    AND p.anonymized_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_lifecycle_emails l
      WHERE l.user_id = u.id AND l.email_key = p_email_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.company_invitations ci
      WHERE lower(ci.email) = lower(u.email::text)
        AND ci.status IN ('pending', 'accepted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.team_invitations ti
      WHERE lower(ti.email) = lower(u.email::text)
        AND ti.status IN ('pending', 'accepted')
    )
  ORDER BY u.email_confirmed_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
$$;

REVOKE EXECUTE ON FUNCTION public.list_users_awaiting_lifecycle_email(text, timestamptz, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_users_awaiting_lifecycle_email(text, timestamptz, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.list_users_awaiting_lifecycle_email(text, timestamptz, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_users_awaiting_lifecycle_email(text, timestamptz, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
