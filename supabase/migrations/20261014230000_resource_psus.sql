-- The PSU-ID a bank resource was created with, kept so that every later call
-- to the same resource sends it again.
--
-- Open Payments (written answer, 2026-10-14): PSU-ID is a required header in
-- production, and when a resource was created with a personnummer as PSU-ID,
-- several banks require the same PSU-ID on every later call to it (reading
-- the consent's accounts and transactions, a payment's status in a decoupled
-- flow, a cancel). Until now the ledger sent the number on file for the
-- connection's owner (or none), and nothing on a payment status read:
--   - an e-mail-login person who typed their number when connecting had
--     nothing on file, so every unattended read went without a PSU-ID;
--   - a consent the firmatecknare signed through the signatory link
--     (/koppla) was created with the firmatecknare's number, but later reads
--     sent the sender's number or none;
--   - a payment was created with the signer's number, and its status reads
--     and cancels sent none.
--
-- Two tables, one row per resource, the personnummer encrypted with the
-- BankID key exactly as payment_signers and bankid_identities hold it
-- (encryptPersonalNumberForStorage, lib/auth/resource-psu.ts):
--   bank_connection_psus  the number a connection's consent was created with
--                         (upserted on every new consent for the row: a
--                         start, a restart or Svea's second consent that
--                         creates one; a co-signer's own authorisation on a
--                         partly signed consent never overwrites it).
--   payment_batch_psus    the number a signing's payments were created with.
--
-- Service role only: RLS on with no policy, and no grant to anon or
-- authenticated, so no browser session ever reads one. Never exported in the
-- archive (personal data that only serves the bank calls, not
-- räkenskapsinformation). Rows go with their connection or signing (ON DELETE
-- CASCADE) and with the company; account erasure deletes the rows of the
-- connections the person owns and of the signings they submitted or signed
-- (erase_user_personal_data, restated below from its current definition in
-- 20261012100400 with those two deletes added; nothing else changes).
--
-- pg-test: covered-by tests/pg/resource-psus.pg.test.ts
-- pg-test: covered-by tests/pg/account-erasure.pg.test.ts

CREATE TABLE public.bank_connection_psus (
  connection_id uuid PRIMARY KEY REFERENCES public.bank_connections(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  psu_id_enc    text NOT NULL,
  source        text NOT NULL CHECK (source IN ('typed', 'on_file', 'signatory_link')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bank_connection_psus_company ON public.bank_connection_psus (company_id);

COMMENT ON TABLE public.bank_connection_psus IS
  'The PSU-ID (personnummer, encrypted) the bank consent of an Open Payments connection was created with, sent again on every later call to the consent. Service-role only; never exported.';
COMMENT ON COLUMN public.bank_connection_psus.psu_id_enc IS
  'The personnummer, AES-256-GCM under the BankID key, as encryptPersonalNumberForStorage writes it.';
COMMENT ON COLUMN public.bank_connection_psus.source IS
  'Where the number came from when the consent was created: typed in the dialog, on file for the person (BankID login or remembered signer), or typed by the firmatecknare on the signatory link.';

ALTER TABLE public.bank_connection_psus ENABLE ROW LEVEL SECURITY;
-- No policies: service role only. The revoke keeps anon and authenticated
-- out even if a policy is ever added by mistake.
REVOKE ALL ON TABLE public.bank_connection_psus FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_connection_psus TO service_role;
-- no-grant: authenticated on public.bank_connection_psus (service-role only: a personnummer read and written by the server's bank calls)
-- no-grant: anon on public.bank_connection_psus (service-role only: a personnummer read and written by the server's bank calls)

CREATE TRIGGER update_bank_connection_psus_updated_at
  BEFORE UPDATE ON public.bank_connection_psus
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.payment_batch_psus (
  batch_id   uuid PRIMARY KEY REFERENCES public.payment_order_batches(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  psu_id_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_batch_psus_company ON public.payment_batch_psus (company_id);

COMMENT ON TABLE public.payment_batch_psus IS
  'The PSU-ID (personnummer, encrypted) the payments of a signing were created with at the bank, sent again on their status reads, restarts and cancels. Service-role only; never exported.';
COMMENT ON COLUMN public.payment_batch_psus.psu_id_enc IS
  'The personnummer, AES-256-GCM under the BankID key, as encryptPersonalNumberForStorage writes it.';

ALTER TABLE public.payment_batch_psus ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_batch_psus FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_batch_psus TO service_role;
-- no-grant: authenticated on public.payment_batch_psus (service-role only: a personnummer read and written by the server's bank calls)
-- no-grant: anon on public.payment_batch_psus (service-role only: a personnummer read and written by the server's bank calls)

-- Account erasure reaches both tables.
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

  -- The PSU-ID a bank consent or a payment signing was created with
  -- (bank_connection_psus, payment_batch_psus): the personnummer, encrypted,
  -- kept for the connections the person owns and the signings they submitted
  -- or signed. Their consents are revoked below; nothing reads these again.
  DELETE FROM public.bank_connection_psus p
   USING public.bank_connections b
   WHERE b.id = p.connection_id
     AND b.user_id = target_user_id;
  DELETE FROM public.payment_batch_psus p
   USING public.payment_order_batches s
   WHERE s.id = p.batch_id
     AND (s.user_id = target_user_id OR s.signer_user_id = target_user_id);

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

NOTIFY pgrst, 'reload schema';
