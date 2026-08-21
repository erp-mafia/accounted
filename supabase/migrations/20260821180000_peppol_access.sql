-- Peppol access is granted per company, never self-served (#546).
--
-- Every Peppol transmission costs money at the Access Point and every
-- receiving identifier consumes a contracted tenant slot, so a company is
-- locked out by default, asks for access from the settings page, and the
-- operators enable it (with a sending cap) from the service role. The table
-- is readable by the company's members and written by nobody but the service
-- role: the browser can ask, it can never grant itself anything.

CREATE TABLE public.peppol_access (
  company_id        uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'enabled', 'disabled')),
  -- Cap on transmissions through the access point; null = no cap.
  max_sends         integer CHECK (max_sends IS NULL OR max_sends >= 0),
  -- Receiving (publishing the company's identifier) is a separate, scarcer
  -- grant: it consumes one of the contracted tenant slots.
  receive_enabled   boolean NOT NULL DEFAULT false,
  requested_at      timestamptz,
  requested_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  request_note      text CHECK (request_note IS NULL OR length(request_note) <= 2000),
  enabled_at        timestamptz,
  -- Free-text label of who granted it (operator e-mail or script name);
  -- operators are not application users, so no FK.
  enabled_by        text,
  disabled_at       timestamptz,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peppol_access_status_shape CHECK (
    (status = 'enabled' AND enabled_at IS NOT NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
    OR status = 'requested'
  )
);

CREATE INDEX peppol_access_status_idx ON public.peppol_access (status, requested_at);

CREATE TRIGGER set_peppol_access_updated_at
  BEFORE UPDATE ON public.peppol_access
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.peppol_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company peppol access"
  ON public.peppol_access FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- Supabase's default privileges hand every new table ALL to authenticated;
-- take that back so a member's UPDATE is a hard "permission denied" rather
-- than an RLS-filtered no-op, then grant the one thing members need.
REVOKE ALL ON public.peppol_access FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.peppol_access TO authenticated;

-- Same tightening for the two receiving tables from 20260821170000, which
-- revoked from PUBLIC and anon only (their RLS already blocked writes; this
-- makes the refusal explicit at the privilege level too).
REVOKE ALL ON public.peppol_registrations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.peppol_registrations TO authenticated;
REVOKE ALL ON public.peppol_inbound_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.peppol_inbound_documents TO authenticated;

NOTIFY pgrst, 'reload schema';
