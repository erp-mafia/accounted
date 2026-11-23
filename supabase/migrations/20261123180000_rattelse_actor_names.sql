-- Who corrected a company's entries, named after the account is deleted.
--
-- A correction states when it was made and who made it (BFL 5 kap. 5 §).
-- The correction log and the processing history built on it are
-- räkenskapsinformation (1 kap. 2 § p. 9), kept until the end of the seventh
-- year after the calendar year in which the fiscal year ended (7 kap. 2 §).
-- Erasure gives way to that obligation (GDPR art. 17.3 b).
--
-- The log rows and the entries hold the person's user id, and the reports
-- name that id from the profile (resolveUserLabelsFromProfiles in
-- lib/reports/behandlingshistorik.ts), which account deletion clears. So
-- erase_user_personal_data first copies the name and e-mail here, one row per
-- company whose entries the person corrected:
--
--   * an inline rättelse: journal_entry_rattelse_log.actor;
--   * a storno: a reversal the person booked (reverses_id set), or a
--     correcting verifikat they booked or posted (correction_of_id set).
--
-- A row lives until the bevarandetid of the latest fiscal year holding one of
-- those corrections has ended; a daily job then deletes it. A person who
-- corrected nothing gets no row, and nothing else about anyone is kept. Only
-- the service role reads the table, for the company's own reports.

CREATE TABLE public.rattelse_actor_names (
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name             text,
  email                 text,
  -- The first day after the bevarandetid: 1 January of the eighth year after
  -- the end of the latest fiscal year holding one of the corrections.
  retention_expires_at  date NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id),
  CONSTRAINT rattelse_actor_names_named CHECK (full_name IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX idx_rattelse_actor_names_user_id ON public.rattelse_actor_names (user_id);

-- No policy: the erasure and the daily job write it, the service role reads it.
ALTER TABLE public.rattelse_actor_names ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rattelse_actor_names FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.rattelse_actor_names TO service_role;

-- The erasure looks a person's inline corrections up by actor.
CREATE INDEX idx_journal_entry_rattelse_log_actor
  ON public.journal_entry_rattelse_log (actor)
  WHERE actor IS NOT NULL;

-- Account erasure keeps those names first: restated from its current
-- definition (20261120090809_company_formations.sql) with the one added INSERT.
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

  -- Before anything is cleared: the name of a person who corrected a
  -- company's entries stays with that company until the bevarandetid ends
  -- (public.rattelse_actor_names, BFL 5 kap. 5 § and 7 kap. 2 §). A reversal
  -- is booked and posted in one call by the person reversing, so its user_id
  -- names them (reversalActor in lib/reports/behandlingshistorik.ts); a
  -- correcting verifikat may be posted by someone other than its author, so
  -- every column that can name a person counts there.
  INSERT INTO public.rattelse_actor_names (company_id, user_id, full_name, email, retention_expires_at)
  SELECT c.company_id, p.id, p.full_name, p.email,
         make_date(extract(year FROM max(fp.period_end))::integer + 8, 1, 1)
    FROM (
          SELECT l.company_id, je.fiscal_period_id
            FROM public.journal_entry_rattelse_log l
            JOIN public.journal_entries je
              ON je.id = l.journal_entry_id
             AND je.company_id = l.company_id
           WHERE l.actor = target_user_id
          UNION ALL
          SELECT je.company_id, je.fiscal_period_id
            FROM public.journal_entries je
           WHERE je.user_id = target_user_id
             AND je.reverses_id IS NOT NULL
             AND je.status IN ('posted', 'reversed')
          UNION ALL
          SELECT je.company_id, je.fiscal_period_id
            FROM public.journal_entries je
           WHERE je.correction_of_id IS NOT NULL
             AND je.status IN ('posted', 'reversed')
             AND target_user_id IN (je.user_id, je.committed_by, je.committed_auth_uid)
         ) c
    JOIN public.fiscal_periods fp ON fp.id = c.fiscal_period_id
    JOIN public.profiles p ON p.id = target_user_id
   WHERE nullif(btrim(p.full_name), '') IS NOT NULL
      OR nullif(btrim(p.email), '') IS NOT NULL
   GROUP BY c.company_id, p.id, p.full_name, p.email
  ON CONFLICT (company_id, user_id) DO NOTHING;

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

-- Daily: a kept name goes once its bevarandetid has ended, counted on the
-- Swedish calendar (public.stockholm_today()), so a row due on 1 January goes
-- only after the Swedish 31 December is over.
CREATE OR REPLACE FUNCTION public.delete_expired_rattelse_actor_names()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.rattelse_actor_names
   WHERE retention_expires_at <= public.stockholm_today();

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_expired_rattelse_actor_names() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_expired_rattelse_actor_names() TO service_role;

SELECT cron.schedule(
  'delete-expired-rattelse-actor-names',
  '45 3 * * *',
  $$SELECT public.delete_expired_rattelse_actor_names()$$
);

NOTIFY pgrst, 'reload schema';
