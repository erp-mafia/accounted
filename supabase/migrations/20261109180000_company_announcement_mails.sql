-- One-time announcement mails to the owners and admins of a company, such as
-- the one telling a company it can now appoint the app as ombud at
-- Skatteverket (extensions/general/skatteverket/lib/ombud-announcement.ts).
--
-- One row per person and company the announcement went to, so the daily cron
-- never sends the same person the same announcement about the same company
-- twice. The row is written (claimed) before the mail goes and removed again
-- only when the provider definitely refused it, so a crash or a second run
-- can never send a duplicate. The person is the auth user id, not the
-- address, so once the account is erased the row names only the tombstone
-- and carries no personal data.
--
-- Service role only: written and read by the cron through the service
-- client; nothing in the browser reads it.

CREATE TABLE public.company_announcement_mails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement text NOT NULL CHECK (announcement IN ('skatteverket_ombud')),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_announcement_mails_once UNIQUE (announcement, company_id, user_id)
);

COMMENT ON TABLE public.company_announcement_mails IS
  'Send log of one-time announcement mails: one row per announcement, company and recipient (extensions/general/skatteverket/lib/ombud-announcement.ts). Service role only.';

CREATE INDEX company_announcement_mails_company_idx
  ON public.company_announcement_mails (company_id);

CREATE INDEX company_announcement_mails_user_idx
  ON public.company_announcement_mails (user_id);

ALTER TABLE public.company_announcement_mails ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_announcement_mails TO service_role;
-- no-grant: authenticated on public.company_announcement_mails (service-role only: written and read by the announcement cron through the service client)
-- no-grant: anon on public.company_announcement_mails (company data)

NOTIFY pgrst, 'reload schema';
