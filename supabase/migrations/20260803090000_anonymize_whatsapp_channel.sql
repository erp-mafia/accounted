-- Extend anonymize_user_account with the WhatsApp channel.
--
-- WHY
-- ---
-- whatsapp_phone_links.user_id is declared REFERENCES auth.users(id) ON DELETE
-- CASCADE (migration 20260802090000), and the channel relied on that cascade
-- for erasure. Accounted never deletes auth.users: account deletion is
-- app/api/account/delete/route.ts -> anonymize_user_account plus a ~100-year
-- ban, which deliberately KEEPS the auth row as a tombstone. The cascade
-- therefore never fires, and nothing else revokes the link: no extension
-- subscribes to account.deleted either.
--
-- Consequence before this migration: after erasure the phone link stayed
-- ACTIVE (revoked_at NULL) with a decryptable phone_enc and the WhatsApp
-- profile name, lookupActiveLink kept resolving the number, and every further
-- inbound message from the erased data subject was persisted with body_text
-- and the verbatim raw_payload while the bot kept replying. That is continued
-- collection with no lawful basis and a GDPR Art 17 gap.
--
-- WHAT
-- ----
-- The RPC is re-created verbatim from 20260724150000 with one added block.
-- The link is REVOKED and crypto-shredded rather than deleted, matching the
-- channel's own revocation-not-deletion discipline and the retention cron's
-- shredding shape (phone_enc = '' is the cleared marker on a NOT NULL column):
--   * revoked_at set  -> lookupActiveLink stops resolving the number, so any
--                        further message falls to the unknown-sender path,
--                        which persists no content at all.
--   * phone_enc = ''  -> the number is no longer recoverable from the row.
--   * wa_profile_name, phone_masked, default/last company -> cleared.
--   * phone_hash STAYS: it is an HMAC under a server-side pepper (not
--     reversible), and it is what keeps "this phone was once linked" honest
--     for the uniqueness history the same way auth.users.email is kept.
--   * conversation state/context reset (pinned company, pending questions).
--   * body_text + raw_payload nulled on every message of that link: same
--     shape as the 90-day retention purge, only immediate.
--   * unused link codes deleted (they mint a NEW link for the erased user).
--
-- Idempotent: every predicate only matches rows still carrying the data, and
-- the RPC already refuses a second run against an anonymized profile.

CREATE OR REPLACE FUNCTION public.anonymize_user_account(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  blocker_count int;
BEGIN
  IF auth.uid() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'Can only delete your own account';
  END IF;

  -- Reject repeat invocations against an already-anonymized tombstone: the
  -- account is gone, re-running would only churn the scrubbed row.
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = target_user_id AND anonymized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Account is already deleted' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO blocker_count
  FROM public.company_members cm
  JOIN public.companies c ON c.id = cm.company_id
  WHERE cm.user_id = target_user_id
    AND cm.role = 'owner'
    AND c.archived_at IS NULL;

  IF blocker_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete account: user still owns % active compan(y/ies)', blocker_count
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.company_members   WHERE user_id = target_user_id;
  DELETE FROM public.team_members      WHERE user_id = target_user_id;
  DELETE FROM public.bankid_identities WHERE user_id = target_user_id;

  DELETE FROM public.user_preferences WHERE user_id = target_user_id;
  DELETE FROM public.api_keys         WHERE user_id = target_user_id;

  -- WhatsApp channel (see header): the auth.users cascade never fires here.
  DELETE FROM public.whatsapp_link_codes WHERE user_id = target_user_id;

  UPDATE public.whatsapp_messages m
     SET body_text   = NULL,
         raw_payload = NULL
    FROM public.whatsapp_phone_links l
   WHERE l.user_id = target_user_id
     AND m.phone_link_id = l.id
     AND (m.body_text IS NOT NULL OR m.raw_payload IS NOT NULL);

  UPDATE public.whatsapp_conversations c
     SET state      = 'idle',
         context    = '{}'::jsonb,
         company_id = NULL
    FROM public.whatsapp_phone_links l
   WHERE l.user_id = target_user_id
     AND c.phone_link_id = l.id;

  UPDATE public.whatsapp_phone_links
     SET revoked_at         = coalesce(revoked_at, now()),
         phone_enc          = '',
         phone_masked       = '+** *** ** **',
         wa_profile_name    = NULL,
         default_company_id = NULL,
         last_company_id    = NULL
   WHERE user_id = target_user_id;

  UPDATE public.profiles
     SET email         = NULL,
         full_name     = NULL,
         avatar_url    = NULL,
         deleted_at    = now(),
         anonymized_at = now(),
         updated_at    = now()
   WHERE id = target_user_id;

  -- Scrub PII from the auth tombstone. auth.users.email is intentionally
  -- kept (blocks re-signup + lets support verify identity for BFL-retained
  -- data recovery; documented legitimate interest, see
  -- app/api/account/delete/route.ts).
  UPDATE auth.users
     SET raw_user_meta_data = '{}'::jsonb,
         raw_app_meta_data  = coalesce(raw_app_meta_data, '{}'::jsonb) - 'bankid_linked' - 'has_password'
   WHERE id = target_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.anonymize_user_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_user_account(uuid) TO authenticated;

-- Repair pass: tombstones anonymized before this migration whose WhatsApp
-- link is still live. Guarded by anonymized_at, so live users are untouched.
UPDATE public.whatsapp_messages m
   SET body_text   = NULL,
       raw_payload = NULL
  FROM public.whatsapp_phone_links l
  JOIN public.profiles p ON p.id = l.user_id
 WHERE p.anonymized_at IS NOT NULL
   AND m.phone_link_id = l.id
   AND (m.body_text IS NOT NULL OR m.raw_payload IS NOT NULL);

UPDATE public.whatsapp_phone_links l
   SET revoked_at         = coalesce(l.revoked_at, now()),
       phone_enc          = '',
       phone_masked       = '+** *** ** **',
       wa_profile_name    = NULL,
       default_company_id = NULL,
       last_company_id    = NULL
  FROM public.profiles p
 WHERE p.id = l.user_id
   AND p.anonymized_at IS NOT NULL
   AND (l.revoked_at IS NULL OR l.phone_enc <> '' OR l.wa_profile_name IS NOT NULL);

NOTIFY pgrst, 'reload schema';
