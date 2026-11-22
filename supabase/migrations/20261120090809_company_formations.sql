-- Company formation drafts ("Starta aktiebolag").
--
-- A founder prepares a new aktiebolag before it exists: the answers for
-- verksamt.se, the founding documents and, after Bolagsverket registers the
-- company, the setup that turns the draft into an Accounted company. The
-- row is user-level until then (no company_id), like bankid_enrichment.
--
-- answers holds the interview as jsonb. Personnummer never sit in it in
-- plain text: the server seals each one (AES-256-GCM, the key the salary
-- module uses) and keeps only the sealed value and the last four digits.
--
-- The owner reads their own rows. Every write goes through the formation
-- API on the service role, which scopes each statement to the signed-in
-- user, so there is no INSERT, UPDATE or DELETE policy: payment, company
-- and setup columns can never be set from the browser.

CREATE TABLE public.company_formations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status                      text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'paid', 'submitted', 'set_up', 'cancelled')),
  answers                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_checkout_session_id  text,
  stripe_customer_id          text,
  stripe_subscription_id      text,
  paid_at                     timestamptz,
  -- When the founder says the application is signed and sent in.
  submitted_at                timestamptz,
  -- The day every founder signed the stiftelseurkund: the date of the first
  -- aktiebok entries (ABL 5 kap. 8 §).
  deed_date                   date,
  company_id                  uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  -- Which setup steps have run, so a retry continues where it stopped.
  setup_state                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  set_up_at                   timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_formations_paid_has_time
    CHECK (status IN ('draft', 'cancelled') OR paid_at IS NOT NULL),
  CONSTRAINT company_formations_set_up_has_company
    CHECK (status <> 'set_up' OR company_id IS NOT NULL)
);

ALTER TABLE public.company_formations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own company formations" ON public.company_formations
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX idx_company_formations_user_id ON public.company_formations (user_id, created_at DESC);
CREATE UNIQUE INDEX idx_company_formations_checkout_session
  ON public.company_formations (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX idx_company_formations_company_id
  ON public.company_formations (company_id)
  WHERE company_id IS NOT NULL;

CREATE TRIGGER set_updated_at_company_formations
  BEFORE UPDATE ON public.company_formations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The owner reads (RLS above); writes are the service role's alone.
GRANT SELECT ON TABLE public.company_formations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_formations TO service_role;

-- The Bolaget registers (aktiebok, styrelse och firmateckning, verkliga
-- huvudmän) for a company set up from a formation, without the rest of the
-- Bolaget rollout (meetings, capital, dividends, owner tax), which stays on
-- BOLAGET_COMPANY_IDS. lib/bolaget/gate.ts reads it; only the formation
-- setup (service role) sets it.
ALTER TABLE public.companies
  ADD COLUMN bolaget_registers_enabled boolean NOT NULL DEFAULT false;

-- Account erasure removes the drafts: restated from its current definition
-- (20261014230000_resource_psus.sql) with the one added DELETE.
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

  -- Company formation drafts (company_formations): the founders' answers,
  -- personnummer sealed, before any company exists. A company already set up
  -- from one keeps its own records; the draft itself goes.
  DELETE FROM public.company_formations WHERE user_id = target_user_id;

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
