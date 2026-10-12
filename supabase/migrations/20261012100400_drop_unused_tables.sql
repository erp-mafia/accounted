-- Drop six tables that were never used and the retired bookkeeping digest.
--
-- Prod evidence (2026-10-11): tax_table_rates, extension_toggles,
-- metered_events, connector_peppol_submissions, cost_centers and projects all
-- hold 0 rows, and no app code reads or writes any of them.
-- notification_settings.email_digest_enabled has had no reader since the
-- digest was retired on 2026-09-24 (DECISIONS.md).
--
-- pg-test: covered-by tests/pg/drop-unused-tables.pg.test.ts

-- 0. Fail closed if prod moved since the evidence above: refuse to drop a
--    table that has gained rows or a journal_entry_lines column that has
--    gained values. Raising here rolls the whole migration back.
DO $guard$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_table_rates', 'extension_toggles', 'metered_events',
                           'connector_peppol_submissions', 'cost_centers', 'projects'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'drop_unused_tables: public.% holds % rows, refusing to drop', t, n;
      END IF;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cost_center_id', 'project_id'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'journal_entry_lines'
                 AND column_name = t) THEN
      EXECUTE format('SELECT count(*) FROM public.journal_entry_lines WHERE %I IS NOT NULL', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'drop_unused_tables: journal_entry_lines.% has % values, refusing to drop', t, n;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

-- 1. Account erasure stops reaching extension_toggles. Restated from its
--    current definition (20261011110100) with that one line removed; nothing
--    else changes. This must run BEFORE the drop: plpgsql bodies are not
--    dependency-tracked, so the drop would succeed and every account deletion
--    would then fail on the missing table.
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
  -- The remembered payment signer holds the same personnummer, encrypted.
  DELETE FROM public.bankid_identities WHERE user_id = target_user_id;
  DELETE FROM public.bankid_enrichment WHERE user_id = target_user_id;
  DELETE FROM public.payment_signers   WHERE user_id = target_user_id;

  -- Personal settings and per-user operational state.
  DELETE FROM public.user_preferences      WHERE user_id = target_user_id;
  DELETE FROM public.notification_settings WHERE user_id = target_user_id;
  DELETE FROM public.notification_log      WHERE user_id = target_user_id;
  DELETE FROM public.push_subscriptions    WHERE user_id = target_user_id;
  DELETE FROM public.notice_dismissals     WHERE user_id = target_user_id;
  DELETE FROM public.email_change_requests WHERE user_id = target_user_id;
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

-- 2. Legacy dimension registries, replaced by dimensions/dimension_values
--    (20260702084500). Prod alone carries journal_entry_lines.cost_center_id
--    and project_id (uuid, FK to these tables, indexed, 0 non-null rows): no
--    repo migration ever created them, hence IF EXISTS so a replay passes.
--    The text columns cost_center and project are live (the legacy mirror kept
--    by lineDimensionColumns()) and are not touched.
--    DDL only: no journal_entry_lines row is written, so no line trigger fires.
ALTER TABLE public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_cost_center_id_fkey;
ALTER TABLE public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_project_id_fkey;
DROP INDEX IF EXISTS public.idx_journal_entry_lines_cost_center;
DROP INDEX IF EXISTS public.idx_journal_entry_lines_project;
ALTER TABLE public.journal_entry_lines DROP COLUMN IF EXISTS cost_center_id;
ALTER TABLE public.journal_entry_lines DROP COLUMN IF EXISTS project_id;

DROP TABLE IF EXISTS public.cost_centers;
DROP TABLE IF EXISTS public.projects;

-- 3. Never populated.
DROP TABLE IF EXISTS public.tax_table_rates;              -- salary reads Skatteverket's API and tax-tables-fallback.ts
DROP TABLE IF EXISTS public.extension_toggles;            -- extensions.config.json is the source of truth
DROP TABLE IF EXISTS public.metered_events;               -- no writer ever shipped
DROP TABLE IF EXISTS public.connector_peppol_submissions; -- the connector Peppol proxy never submitted

-- 4. The retired "Nytt att bokföra" digest (20260831100000). Its dedup rows
--    (2026-08-31 to 2026-09-24) would fail the narrowed CHECK.
--    notification_log is a dedup log (ARCHIVE_EXCLUDED_TABLES), not
--    räkenskapsinformation.
DELETE FROM public.notification_log WHERE notification_type = 'bookkeeping_digest';

DROP INDEX IF EXISTS public.idx_notification_log_bookkeeping_digest_dedup;

ALTER TABLE public.notification_log
  DROP CONSTRAINT IF EXISTS notification_log_notification_type_check;
ALTER TABLE public.notification_log
  ADD CONSTRAINT notification_log_notification_type_check
  CHECK (notification_type IN (
    'tax_deadline',
    'invoice_due',
    'invoice_overdue',
    'period_locked',
    'period_year_closed',
    'invoice_sent',
    'receipt_extracted',
    'receipt_matched',
    'missing_underlag',
    'skv_kvittens',
    'skv_connection_expired'
  )) NOT VALID;
ALTER TABLE public.notification_log
  VALIDATE CONSTRAINT notification_log_notification_type_check;

ALTER TABLE public.notification_settings DROP COLUMN IF EXISTS email_digest_enabled;

NOTIFY pgrst, 'reload schema';
