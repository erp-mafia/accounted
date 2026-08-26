-- Peppol receiving (#546, PR2): per-company participant registrations at the
-- Access Point and the archive of inbound documents.
--
-- peppol_registrations: which companies publish a Peppol identifier through
-- our provider account (Qvalia partner model: every id lives on the partner
-- account, so the provider reference is the same for all; multi-tenant child
-- accounts would only change that column).
--
-- peppol_inbound_documents: every document the Access Point hands us, with
-- the exact received XML. A received e-invoice is räkenskapsinformation, so
-- the payload columns are immutable and rows cannot be deleted; processing
-- state lives beside them and is the only thing that changes.

CREATE TABLE public.peppol_registrations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider                    text NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 64),
  provider_account_reference  text,
  participant_scheme          text NOT NULL CHECK (participant_scheme ~ '^[0-9]{4}$'),
  participant_identifier      text NOT NULL CHECK (length(btrim(participant_identifier)) BETWEEN 1 AND 64),
  status                      text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'registered', 'failed', 'deregistered')),
  business_card               jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_types              jsonb NOT NULL DEFAULT '[]'::jsonb,
  registered_at               timestamptz,
  deregistered_at             timestamptz,
  last_error                  text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peppol_registrations_status_shape CHECK (
    (status = 'registered' AND registered_at IS NOT NULL)
    OR (status = 'deregistered' AND deregistered_at IS NOT NULL)
    OR status IN ('pending', 'failed')
  )
);

-- One live registration per participant and per company at a time; history
-- rows (failed / deregistered) may accumulate.
CREATE UNIQUE INDEX peppol_registrations_live_participant
  ON public.peppol_registrations (provider, participant_scheme, participant_identifier)
  WHERE status IN ('pending', 'registered');
CREATE UNIQUE INDEX peppol_registrations_live_company
  ON public.peppol_registrations (company_id, provider)
  WHERE status IN ('pending', 'registered');
CREATE INDEX peppol_registrations_company_idx
  ON public.peppol_registrations (company_id);

CREATE TRIGGER set_peppol_registrations_updated_at
  BEFORE UPDATE ON public.peppol_registrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.peppol_registrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company peppol registrations"
  ON public.peppol_registrations FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- Writes happen through the registration route with the service role after
-- the membership check; the browser never writes provider state directly.
REVOKE ALL ON public.peppol_registrations FROM PUBLIC, anon;
GRANT SELECT ON public.peppol_registrations TO authenticated;

-- ---------------------------------------------------------------------------

CREATE TABLE public.peppol_inbound_documents (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                text NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 64),
  provider_document_id    text NOT NULL CHECK (length(btrim(provider_document_id)) BETWEEN 1 AND 128),
  document_type           text NOT NULL CHECK (document_type IN ('Invoice', 'CreditNote')),
  document_id             text,
  issue_date              date,
  due_date                date,
  currency                text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  payable_amount          numeric(14, 2),
  sender_scheme           text CHECK (sender_scheme IS NULL OR sender_scheme ~ '^[0-9]{4}$'),
  sender_identifier       text,
  sender_name             text,
  recipient_scheme        text CHECK (recipient_scheme IS NULL OR recipient_scheme ~ '^[0-9]{4}$'),
  recipient_identifier    text,
  -- Resolved from the recipient identifier via peppol_registrations; null
  -- until routed (and stays null for a document nobody is registered for).
  company_id              uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  status                  text NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received', 'routed', 'unrouted', 'converted', 'ignored', 'failed')),
  inbox_item_id           uuid REFERENCES public.invoice_inbox_items(id) ON DELETE SET NULL,
  supplier_invoice_id     uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL,
  -- The exact XML archived as a WORM document (document_attachments) once
  -- the document is routed to a company; the archive is company-scoped, so it
  -- cannot exist before routing.
  xml_document_id         uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  xml_payload             text,
  xml_sha256              text CHECK (xml_sha256 IS NULL OR xml_sha256 ~ '^[0-9a-f]{64}$'),
  ubl_json                jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at             timestamptz NOT NULL DEFAULT now(),
  processed_at            timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peppol_inbound_documents_provider_document_unique UNIQUE (provider, provider_document_id),
  CONSTRAINT peppol_inbound_documents_routed_shape CHECK (
    status IN ('received', 'unrouted', 'failed') OR company_id IS NOT NULL
  )
);

CREATE INDEX peppol_inbound_documents_company_idx
  ON public.peppol_inbound_documents (company_id, received_at DESC);
CREATE INDEX peppol_inbound_documents_status_idx
  ON public.peppol_inbound_documents (status)
  WHERE status IN ('received', 'unrouted', 'routed', 'failed');
CREATE INDEX peppol_inbound_documents_inbox_item_idx
  ON public.peppol_inbound_documents (inbox_item_id)
  WHERE inbox_item_id IS NOT NULL;

CREATE TRIGGER set_peppol_inbound_documents_updated_at
  BEFORE UPDATE ON public.peppol_inbound_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The received document is immutable once stored: the payload, its hash, the
-- provider correlation and what it says about itself never change; only the
-- processing columns do. Deletion is blocked for everyone (BFL 7 kap).
CREATE OR REPLACE FUNCTION public.enforce_peppol_inbound_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inbound Peppol documents cannot be deleted (BFL 7 kap)'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.xml_payload IS NOT NULL AND NEW.xml_payload IS DISTINCT FROM OLD.xml_payload THEN
    RAISE EXCEPTION 'Inbound Peppol document payload is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.xml_sha256 IS NOT NULL AND NEW.xml_sha256 IS DISTINCT FROM OLD.xml_sha256 THEN
    RAISE EXCEPTION 'Inbound Peppol document hash is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_document_id IS DISTINCT FROM OLD.provider_document_id
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
  THEN
    RAISE EXCEPTION 'Inbound Peppol document identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.company_id IS NOT NULL AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Inbound Peppol document cannot be re-routed once routed' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_peppol_inbound_immutability
  BEFORE UPDATE OR DELETE ON public.peppol_inbound_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_peppol_inbound_immutability();

ALTER TABLE public.peppol_inbound_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company peppol inbound documents"
  ON public.peppol_inbound_documents FOR SELECT
  USING (company_id IS NOT NULL AND company_id IN (SELECT public.user_company_ids()));
-- Inbound documents are written by the polling job (service role) only.
REVOKE ALL ON public.peppol_inbound_documents FROM PUBLIC, anon;
GRANT SELECT ON public.peppol_inbound_documents TO authenticated;

-- ---------------------------------------------------------------------------
-- The inbox learns a new intake channel. Same DROP + ADD NOT VALID + VALIDATE
-- idiom as the whatsapp and mail_hunt widenings, and a per-channel dedupe
-- index keyed on the provider's document id, as the other channels have.

ALTER TABLE public.invoice_inbox_items
  DROP CONSTRAINT IF EXISTS invoice_inbox_items_source_check;
ALTER TABLE public.invoice_inbox_items
  ADD CONSTRAINT invoice_inbox_items_source_check
  CHECK (source IN ('email', 'upload', 'whatsapp', 'mail_hunt', 'peppol')) NOT VALID;
ALTER TABLE public.invoice_inbox_items
  VALIDATE CONSTRAINT invoice_inbox_items_source_check;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_peppol_document_unique
  ON public.invoice_inbox_items (company_id, (channel_context->>'peppol_document_id'))
  WHERE source = 'peppol';

NOTIFY pgrst, 'reload schema';
