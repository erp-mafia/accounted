-- Drop delete_user_account and commit anonymize_user_account to the repo.
--
-- WHY THIS MIGRATION EXISTS (issue #342, critical)
-- ------------------------------------------------
-- public.delete_user_account (last defined by 20260415000000_schema_sync.sql)
-- DISABLEs the BFL retention triggers (block_document_deletion,
-- enforce_retention_journal_entries, enforce_journal_entry_immutability,
-- audit_log_no_delete, and friends), DELETEs audit_log rows for every company
-- the user created, and then DELETEs the auth.users row, cascading away
-- journal entries and documents. That destroys rakenskapsinformation that
-- BFL 7 kap 2 paragraf requires us to retain for 7 years. It is SECURITY
-- DEFINER with only a self-only guard (auth.uid() = target_user_id) and no
-- REVOKE, so any authenticated user could call it via PostgREST and legally
-- wipe their own company's books. The function must not exist at all: the
-- retention triggers are the legal backstop and no callable path may disable
-- them.
--
-- The product path already uses public.anonymize_user_account
-- (app/api/account/delete/route.ts): it scrubs PII from profiles and removes
-- memberships/keys, but leaves all bookkeeping data untouched. That function
-- so far existed only on production with no migration in the repo; this
-- migration commits the production definition verbatim (drift capture, no
-- behavior change) and locks down its grants in house style.

-- 1. Drop the retention-bypassing RPC.
DROP FUNCTION IF EXISTS public.delete_user_account(uuid);

-- 2. Drift capture: production's profiles table carries the tombstone columns
--    the function writes, but no repo migration ever added them. Add them
--    idempotently so from-scratch databases (CI replay, self-hosted) match.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

-- 3. Commit the production definition of anonymize_user_account verbatim.
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

  UPDATE public.profiles
     SET email         = NULL,
         full_name     = NULL,
         avatar_url    = NULL,
         deleted_at    = now(),
         anonymized_at = now(),
         updated_at    = now()
   WHERE id = target_user_id;
END;
$function$;

-- 4. Grants: self-only guard inside, but never callable by anon/PUBLIC.
REVOKE ALL ON FUNCTION public.anonymize_user_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_user_account(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
