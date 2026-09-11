-- Complete account erasure: every personal-data store of a deleted user.
--
-- WHY
-- ---
-- Accounted never deletes auth.users. Account deletion is
-- app/api/account/delete/route.ts -> anonymize_user_account plus a ~100-year
-- ban, which keeps the auth row as a tombstone so BFL-retained bookkeeping
-- keeps its foreign keys. No `REFERENCES auth.users ON DELETE CASCADE` in the
-- schema therefore ever fires, and erasure reached only the tables someone
-- remembered to list in the RPC. Migration 20260803090000 closed that gap for
-- WhatsApp. A prod audit on 2026-09-10 found the rest, across the 33
-- tombstones that existed then:
--   * bankid_enrichment (12 rows). For an enskild näringsidkare, TIC's
--     CompanyRoles carries the owner's personnummer as the first 12 digits of
--     companyRegistrationNumber, so 6 erased users still had a plaintext
--     personnummer on file after the encrypted copy in bankid_identities had
--     been deleted.
--   * bank_connections. PSD2 consents given with the erased person's BankID
--     kept syncing: 6 still active, last sync on the day of the audit.
--   * skatteverket_tokens (6), agent_conversations (22, plus messages),
--     agent_rate_counters (76), auth.flow_state (8), auth.one_time_tokens (2).
--   * auth.identities: 33 rows; the 4 Google identities kept the Google
--     profile (full_name, name, avatar_url, picture).
--   * auth.sessions (13) and their refresh tokens were never ended: the
--     route's auth.admin.signOut() takes a JWT, not a user id.
--   * auth.users.email was kept indefinitely to block re-signup, while the
--     published privacy policy promised account data is removed at most 30
--     days after the deletion request.
--
-- WHAT
-- ----
-- 1. public.erase_user_personal_data(uuid) is the one definition of erasure.
--    anonymize_user_account calls it after its guards, and the repair pass at
--    the bottom calls it for every existing tombstone, so an old tombstone
--    ends in exactly the state a new deletion produces. It has no auth.uid()
--    check of its own: SECURITY INVOKER, and EXECUTE revoked from everyone
--    but its owner, so it only runs inside anonymize_user_account (SECURITY
--    DEFINER) or as the migration role.
-- 2. Deleted: user-scoped state with no retention basis. Memberships, API
--    keys, OAuth client registrations and flows, one-time codes, calendar feed
--    tokens, Skatteverket tokens, BankID identity and enrichment, preferences,
--    notification settings and log, push subscriptions, notice dismissals,
--    pending email changes, extension toggles, idempotency keys, MCP tasks,
--    rate counters, sandbox seed locks, chat and assistant conversations
--    (agent_messages cascade).
-- 3. Revoked in place: bank_connections and mail_connections. Transactions,
--    cash_accounts and imported underlag reference those rows, so they stay;
--    the consent was the erased person's, so what made it usable is shredded
--    and status becomes 'revoked' (the bank sync and the mail search read only
--    status = 'active'). That includes an archived migration-reset source
--    company: block_migration_reset_source_mutation keeps its records
--    unchanged and now lets exactly one change through on bank_connections,
--    the revoke that shreds the consent (status 'revoked', credentials and
--    accounts_data NULL, the rest of the row identical). A consent is not an
--    accounting record, and an erased user must not keep one anywhere.
-- 4. Retained: company-owned records, above all bookkeeping under BFL 7 kap.
--    2 § and its processing history. They point at the tombstone id and carry
--    no personal data of the erased user. tests/pg/account-erasure.pg.test.ts
--    classifies every foreign key to auth.users and fails on one that is not
--    classified, which is what keeps this class of gap from coming back.
-- 5. auth: refresh tokens, sessions, MFA factors, flow state, one-time tokens
--    and identities are deleted, and the email is cleared. GoTrue creates
--    several of those tables at startup rather than the database image, so
--    they are reached through to_regclass-guarded dynamic SQL and the function
--    works on a database without them (pg-real CI, a self-hosted database
--    before GoTrue's first boot). Identities go BEFORE the email is cleared:
--    unlink_old_address_identities (BEFORE UPDATE OF email) would otherwise
--    re-insert an email identity for the tombstone and write the erased
--    address into auth.audit_log_entries.
--
-- Clearing the email ends the re-signup block the tombstone used to give: the
-- same address can now register a new, empty account. That is a product
-- preference, not a retention basis; see DECISIONS.md 2026-09-10.

-- Migration-reset source companies are retention containers (20260818084050):
-- their rows stay unchanged. The one change let through is revoking a bank
-- consent, which alters no accounting-shaped data and is what erasure needs
-- (header, point 3). The IFs are nested because NEW.session_id only exists on
-- bank_connections and AND gives no evaluation-order guarantee.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_company_id uuid;
  v_new_company_id uuid;
  v_revoke_columns text[] := ARRAY['status', 'session_id', 'authorization_id', 'oauth_state', 'accounts_data', 'updated_at'];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_company_id := OLD.company_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_company_id := NEW.company_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.company_migration_resets
    WHERE source_company_id IN (v_old_company_id, v_new_company_id)
  ) THEN
    IF TG_TABLE_NAME = 'bank_connections' AND TG_OP = 'UPDATE' THEN
      IF NEW.status = 'revoked'
         AND NEW.session_id IS NULL
         AND NEW.authorization_id IS NULL
         AND NEW.oauth_state IS NULL
         AND NEW.accounts_data IS NULL
         AND (to_jsonb(NEW) - v_revoke_columns) = (to_jsonb(OLD) - v_revoke_columns)
      THEN
        RETURN NEW;
      END IF;
    END IF;

    RAISE EXCEPTION 'Archived migration reset source records are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.erase_user_personal_data(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  auth_table text;
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'erase_user_personal_data: target_user_id is required';
  END IF;

  -- Access: memberships and every credential the person could act through.
  DELETE FROM public.company_members            WHERE user_id = target_user_id;
  DELETE FROM public.team_members               WHERE user_id = target_user_id;
  DELETE FROM public.api_keys                   WHERE user_id = target_user_id;
  DELETE FROM public.oauth_client_registrations WHERE user_id = target_user_id;
  DELETE FROM public.oauth_flows                WHERE user_id = target_user_id;
  DELETE FROM public.provider_otc               WHERE user_id = target_user_id;
  DELETE FROM public.calendar_feeds             WHERE user_id = target_user_id;
  DELETE FROM public.skatteverket_tokens        WHERE user_id = target_user_id;

  -- BankID: the encrypted personnummer, and the CompanyRoles cache whose
  -- companyRegistrationNumber is the personnummer for an enskild näringsidkare.
  DELETE FROM public.bankid_identities WHERE user_id = target_user_id;
  DELETE FROM public.bankid_enrichment WHERE user_id = target_user_id;

  -- Personal settings and per-user operational state.
  DELETE FROM public.user_preferences      WHERE user_id = target_user_id;
  DELETE FROM public.notification_settings WHERE user_id = target_user_id;
  DELETE FROM public.notification_log      WHERE user_id = target_user_id;
  DELETE FROM public.push_subscriptions    WHERE user_id = target_user_id;
  DELETE FROM public.notice_dismissals     WHERE user_id = target_user_id;
  DELETE FROM public.email_change_requests WHERE user_id = target_user_id;
  DELETE FROM public.extension_toggles     WHERE user_id = target_user_id;
  DELETE FROM public.idempotency_keys      WHERE user_id = target_user_id;
  DELETE FROM public.mcp_tasks             WHERE user_id = target_user_id;
  DELETE FROM public.agent_rate_counters   WHERE user_id = target_user_id;
  DELETE FROM public.sandbox_seed_attempts WHERE user_id = target_user_id;

  -- Conversations. agent_messages cascade from agent_conversations.
  DELETE FROM public.agent_conversations WHERE user_id = target_user_id;
  DELETE FROM public.chat_messages       WHERE user_id = target_user_id;
  DELETE FROM public.chat_sessions       WHERE user_id = target_user_id;

  -- Consents the person gave for a company (header, point 3).
  UPDATE public.bank_connections b
     SET status           = 'revoked',
         session_id       = NULL,
         authorization_id = NULL,
         oauth_state      = NULL,
         accounts_data    = NULL
   WHERE b.user_id = target_user_id
     AND (b.status <> 'revoked'
          OR b.session_id IS NOT NULL
          OR b.authorization_id IS NOT NULL
          OR b.oauth_state IS NOT NULL
          OR b.accounts_data IS NOT NULL);

  -- The mailbox may be the person's own: its address goes too. A per-row
  -- placeholder keeps the (company_id, provider, email_address) index unique.
  UPDATE public.mail_connections m
     SET status                  = 'revoked',
         email_address           = 'erased+' || m.id::text || '@anonymized.invalid',
         encrypted_refresh_token = '',
         encrypted_access_token  = NULL,
         access_token_expires_at = NULL,
         connected_by            = NULL
   WHERE m.connected_by = target_user_id;

  -- WhatsApp channel, unchanged from 20260803090000: the link is revoked and
  -- crypto-shredded rather than deleted.
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

  -- GoTrue-managed rows (header, point 5). refresh_tokens.user_id is varchar.
  IF to_regclass('auth.refresh_tokens') IS NOT NULL THEN
    EXECUTE 'DELETE FROM auth.refresh_tokens WHERE user_id = $1' USING target_user_id::text;
  END IF;

  FOREACH auth_table IN ARRAY ARRAY[
    'auth.sessions', 'auth.mfa_factors', 'auth.flow_state', 'auth.one_time_tokens', 'auth.identities'
  ] LOOP
    IF to_regclass(auth_table) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %s WHERE user_id = $1', auth_table) USING target_user_id;
    END IF;
  END LOOP;

  UPDATE public.profiles
     SET email         = NULL,
         full_name     = NULL,
         avatar_url    = NULL,
         deleted_at    = coalesce(deleted_at, now()),
         anonymized_at = coalesce(anonymized_at, now()),
         updated_at    = now()
   WHERE id = target_user_id;

  -- Only after identities are gone (header, point 5). email_change stays a
  -- string: GoTrue scans it into a non-nullable field.
  UPDATE auth.users
     SET email              = NULL,
         email_change       = '',
         raw_user_meta_data = '{}'::jsonb,
         raw_app_meta_data  = coalesce(raw_app_meta_data, '{}'::jsonb) - 'bankid_linked' - 'has_password'
   WHERE id = target_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.erase_user_personal_data(uuid) FROM PUBLIC, anon, authenticated, service_role;

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

  PERFORM public.erase_user_personal_data(target_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.anonymize_user_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_user_account(uuid) TO authenticated;

-- Repair pass: every tombstone created before this migration gets the erasure
-- a new deletion gets. Guarded by anonymized_at, so live users are untouched;
-- erase_user_personal_data is idempotent.
DO $repair$
DECLARE
  tombstone_id uuid;
BEGIN
  FOR tombstone_id IN
    SELECT id FROM public.profiles WHERE anonymized_at IS NOT NULL ORDER BY anonymized_at
  LOOP
    PERFORM public.erase_user_personal_data(tombstone_id);
  END LOOP;
END
$repair$;

NOTIFY pgrst, 'reload schema';
