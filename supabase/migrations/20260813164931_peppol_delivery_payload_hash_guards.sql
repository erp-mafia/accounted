-- Ensure immutable Peppol documents are cryptographically bound to their
-- stored SHA-256 values even when an RPC is called outside the application.

CREATE OR REPLACE FUNCTION public.enforce_peppol_delivery_payload_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, extensions
AS $$
BEGIN
  IF encode(extensions.digest(NEW.xml_payload, 'sha256'), 'hex')
    IS DISTINCT FROM NEW.xml_sha256
  THEN
    RAISE EXCEPTION 'Peppol XML SHA-256 does not match the staged payload'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_peppol_delivery_payload_hash
  BEFORE INSERT ON public.peppol_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_peppol_delivery_payload_hash();

CREATE OR REPLACE FUNCTION public.enforce_peppol_evidence_document_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, extensions
AS $$
BEGIN
  IF NEW.document_payload IS NOT NULL
    AND encode(extensions.digest(NEW.document_payload, 'sha256'), 'hex')
      IS DISTINCT FROM NEW.document_sha256
  THEN
    RAISE EXCEPTION 'Peppol evidence document SHA-256 does not match the payload'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_peppol_evidence_document_hash
  BEFORE INSERT ON public.peppol_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION public.enforce_peppol_evidence_document_hash();

REVOKE ALL ON FUNCTION public.enforce_peppol_delivery_payload_hash()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_peppol_evidence_document_hash()
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
