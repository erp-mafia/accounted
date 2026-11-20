-- BankID document signing: a signing request ("signeringsuppdrag") is one PDF
-- in the archive, frozen by its SHA-256, and the people who should sign it.
-- Each signer opens /signera/<token> (or signs in the app when they are a
-- member), sees the document and signs with BankID through TIC Identity
-- (lib/signing/bankid-provider.ts). The signature binds the document hash
-- (userNonVisibleData) and the text the signer approved (userVisibleData).
-- When the last signer signs, the server seals a signed PDF and an evidence
-- package (Bevispaket.zip) into the archive.
--
-- Three tables:
--   signing_requests         the request: document, hash, status, the signed copies
--   signing_request_signers  one row per person: name, link, status, BankID name
--   signing_signer_private   per signer: the personnummer lock and the BankID
--                            signature (XML-DSig, OCSP). Both carry a full or
--                            hashed personnummer, so service role only and no
--                            audit trigger (write_audit_log stores to_jsonb(row)).
--
-- Every write is the server's, as the service role, after a route checked the
-- sender, the token or the member. Members read their company's requests and
-- signers (never the token hash). A signature is recorded only through
-- record_signing_signature (below), which also consumes the BankID session.
-- Signed rows are evidence: frozen, and never deleted outside the sandbox
-- teardown. A request nobody signed yet may go with its document.
--
-- pg-test: covered-by tests/pg/signing-requests.pg.test.ts

-- =============================================================================
-- 1. signing_requests
-- =============================================================================

CREATE TABLE public.signing_requests (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Who asked; the company keeps it as the record of who sent the document for signing.
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_via           text NOT NULL CHECK (created_via IN ('app', 'api', 'mcp')),
  -- The PDF that is signed, and its hash when the request was made. CASCADE
  -- only so the sandbox teardown's document delete takes the request along;
  -- signing_requests_guard refuses it for a request anyone has signed.
  document_id           uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  document_sha256       text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  title                 text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  message               text CHECK (message IS NULL OR char_length(message) <= 1000),
  -- Set when the request carries the board's signatures on a locked
  -- årsredovisning version: each signer is one of its signature slots.
  annual_report_version_id uuid REFERENCES public.annual_report_versions(id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'declined', 'cancelled')),
  expires_at            timestamptz NOT NULL,
  completed_at          timestamptz,
  declined_at           timestamptz,
  cancelled_at          timestamptz,
  -- The sealed copies, set once after completion (lib/signing/seal.ts).
  signed_document_id    uuid REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  evidence_document_id  uuid REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- 90 days at most; the extra day absorbs the app clock running ahead of the database's.
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '91 days'),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'declined') = (declined_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status = 'completed' OR (signed_document_id IS NULL AND evidence_document_id IS NULL))
);

COMMENT ON TABLE public.signing_requests IS
  'BankID signing requests: one archived PDF, frozen by SHA-256, and its signers (signing_request_signers). Written by the server only; a signature is recorded through record_signing_signature.';
COMMENT ON COLUMN public.signing_requests.document_sha256 IS
  'SHA-256 of the PDF when the request was made; every BankID signature carries it in userNonVisibleData, and the seal re-hashes the stored file against it.';
COMMENT ON COLUMN public.signing_requests.expires_at IS
  'Links stop working after this; expiry is read lazily (no cron), an open request past it counts as expired.';

CREATE INDEX signing_requests_company ON public.signing_requests (company_id, created_at DESC);
CREATE INDEX signing_requests_document ON public.signing_requests (document_id);
CREATE INDEX signing_requests_signed_document ON public.signing_requests (signed_document_id) WHERE signed_document_id IS NOT NULL;
CREATE INDEX signing_requests_evidence_document ON public.signing_requests (evidence_document_id) WHERE evidence_document_id IS NOT NULL;
-- One open request per årsredovisning version.
CREATE UNIQUE INDEX signing_requests_one_open_per_version ON public.signing_requests (annual_report_version_id)
  WHERE annual_report_version_id IS NOT NULL AND status = 'open';

-- =============================================================================
-- 2. signing_request_signers
-- =============================================================================

CREATE TABLE public.signing_request_signers (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  signing_request_id    uuid NOT NULL REFERENCES public.signing_requests(id) ON DELETE CASCADE,
  position              smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  name                  text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  email                 text CHECK (email IS NULL OR char_length(email) <= 254),
  role_label            text CHECK (role_label IS NULL OR char_length(role_label) <= 100),
  -- A member signer signs in the app too; their lock comes from their own
  -- BankID login (bankid_identities), never a copy.
  user_id               uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  -- none: anyone with the link signs and their BankID name is recorded;
  -- member: only user_id's BankID identity; personnummer: only the number
  -- in signing_signer_private.
  lock_kind             text NOT NULL DEFAULT 'none' CHECK (lock_kind IN ('none', 'member', 'personnummer')),
  -- The årsredovisning signature slot this signer fills (requests with an
  -- annual_report_version_id only). CASCADE only for the sandbox teardown,
  -- which deletes the slots first; the guard refuses it otherwise once signed.
  annual_report_signature_id uuid REFERENCES public.arsredovisning_signature_requests(id) ON DELETE CASCADE,
  -- sha256 of the clear link token, which exists only in the URL and the mail.
  token_hash            text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  link_sent_at          timestamptz,
  last_reminded_at      timestamptz,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'declined')),
  -- The TIC sign session in progress, kept here rather than in the shared
  -- BankID flow cookie so a login in the same browser is never overwritten.
  bankid_session_id     text CHECK (bankid_session_id IS NULL OR char_length(bankid_session_id) <= 100),
  bankid_session_started_at timestamptz,
  -- A short lease so two concurrent polls never both ask TIC for the result,
  -- which TIC hands out at most twice.
  poll_lease_until      timestamptz,
  signed_at             timestamptz,
  bankid_given_name     text,
  bankid_surname        text,
  -- Exactly what the BankID app showed and the signature binds.
  user_visible_data     text CHECK (user_visible_data IS NULL OR char_length(user_visible_data) <= 40000),
  declined_at           timestamptz,
  decline_reason        text CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 500),
  -- Why the latest attempt was refused (for example a name that does not match the slot).
  last_error_code       text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signing_request_id, position),
  CHECK (lock_kind <> 'member' OR user_id IS NOT NULL),
  CHECK ((status = 'signed') = (signed_at IS NOT NULL)),
  CHECK (status <> 'signed' OR (bankid_given_name IS NOT NULL AND bankid_surname IS NOT NULL AND user_visible_data IS NOT NULL)),
  CHECK ((status = 'declined') = (declined_at IS NOT NULL))
);

COMMENT ON TABLE public.signing_request_signers IS
  'One signer of a signing request: the link (token hashed), the status, and once signed the BankID name and the exact text the BankID app showed. The signature itself is in signing_signer_private.';
COMMENT ON COLUMN public.signing_request_signers.token_hash IS
  'sha256 of the clear link token, which exists only in the URL (and the mail that carried it). Service-role read only.';

CREATE INDEX signing_request_signers_request ON public.signing_request_signers (signing_request_id);
CREATE INDEX signing_request_signers_company ON public.signing_request_signers (company_id);
CREATE INDEX signing_request_signers_member_pending ON public.signing_request_signers (user_id)
  WHERE user_id IS NOT NULL AND status = 'pending';
CREATE INDEX signing_request_signers_slot ON public.signing_request_signers (annual_report_signature_id)
  WHERE annual_report_signature_id IS NOT NULL;

-- =============================================================================
-- 3. signing_signer_private
-- =============================================================================

CREATE TABLE public.signing_signer_private (
  signer_id                   uuid PRIMARY KEY REFERENCES public.signing_request_signers(id) ON DELETE CASCADE,
  company_id                  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- lock_kind 'personnummer': the number typed by the sender. The encrypted
  -- copy (BANKID_ENCRYPTION_KEY) is sent to TIC so only that person can sign
  -- the order, and is dropped once they signed; the hash stays.
  lock_personnummer_hash      text CHECK (lock_personnummer_hash IS NULL OR lock_personnummer_hash ~ '^[0-9a-f]{64}$'),
  lock_personnummer_encrypted bytea,
  -- The BankID signature: XML-DSig (base64; carries the signer's certificate
  -- with the full personnummer) and the OCSP response (base64).
  bankid_personnummer_hash    text CHECK (bankid_personnummer_hash IS NULL OR bankid_personnummer_hash ~ '^[0-9a-f]{64}$'),
  -- "XXXXXXXX-1234" (maskPersonalNumber), for the signed copy's evidence page.
  personnummer_masked         text CHECK (personnummer_masked IS NULL OR personnummer_masked ~ '^X{6,8}-[0-9]{4}$'),
  signature_xml               text,
  ocsp_response               text,
  bankid_session_id           text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (lock_personnummer_encrypted IS NULL OR lock_personnummer_hash IS NOT NULL),
  CHECK ((signature_xml IS NULL) = (ocsp_response IS NULL)),
  CHECK (signature_xml IS NULL OR (bankid_personnummer_hash IS NOT NULL AND bankid_session_id IS NOT NULL))
);

COMMENT ON TABLE public.signing_signer_private IS
  'Per signer: the personnummer lock and the BankID signature (XML-DSig and OCSP, which carry the full personnummer). Service role only, never exported as a table (the evidence package in the archive carries the signatures), no audit trigger.';

CREATE INDEX signing_signer_private_company ON public.signing_signer_private (company_id);

-- =============================================================================
-- 4. Consistency: signer, request and slot belong together
-- =============================================================================

CREATE OR REPLACE FUNCTION public.signing_signer_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  v_request public.signing_requests%ROWTYPE;
BEGIN
  -- A signer starts pending; only record_signing_signature makes a signature.
  IF NEW.status <> 'pending' OR NEW.signed_at IS NOT NULL OR NEW.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'SIGNING_SIGNATURE_RPC_ONLY: a signer is created pending'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_request FROM public.signing_requests r WHERE r.id = NEW.signing_request_id;
  IF NOT FOUND OR v_request.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_COMPANY_MISMATCH: a signer belongs to its request''s company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v_request.annual_report_version_id IS NULL) <> (NEW.annual_report_signature_id IS NULL) THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_SLOT_MISMATCH: an årsredovisning request has one slot per signer, other requests none'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.annual_report_signature_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.arsredovisning_signature_requests s
     WHERE s.id = NEW.annual_report_signature_id
       AND s.company_id = NEW.company_id
       AND s.annual_report_version_id = v_request.annual_report_version_id
  ) THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_SLOT_MISMATCH: the slot is bound to the request''s årsredovisning version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signing_signer_consistency
  BEFORE INSERT ON public.signing_request_signers
  FOR EACH ROW EXECUTE FUNCTION public.signing_signer_consistency();

CREATE OR REPLACE FUNCTION public.signing_private_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.signing_request_signers s
                  WHERE s.id = NEW.signer_id AND s.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_COMPANY_MISMATCH: private signer data belongs to its signer''s company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.signature_xml IS NOT NULL
     AND current_setting('gnubok.recording_signature', true) IS DISTINCT FROM NEW.signer_id::text THEN
    RAISE EXCEPTION 'SIGNING_SIGNATURE_RPC_ONLY: a signature is recorded through record_signing_signature'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signing_private_consistency
  BEFORE INSERT ON public.signing_signer_private
  FOR EACH ROW EXECUTE FUNCTION public.signing_private_consistency();

-- =============================================================================
-- 5. Guards: signed evidence is frozen and never deleted
-- =============================================================================
-- The one exception is the sandbox teardown: inside cleanup_sandbox_user
-- (flag set, running as its owner) rows of a company that company_settings
-- still marks as a sandbox may go, as the cascades from its slot and document
-- deletes take them (the counterparty_setoffs_guard pattern, 20261022130100).

CREATE OR REPLACE FUNCTION public.signing_in_sandbox_teardown(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  SELECT current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)
     AND coalesce((SELECT pg_catalog.bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = p_company_id), false)
$$;

CREATE OR REPLACE FUNCTION public.signing_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The flag is read here too, not only in the helper: the teardown
    -- coverage test (sandbox-teardown-coverage.pg.test.ts) reads each guard's
    -- own body for it.
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
       AND public.signing_in_sandbox_teardown(OLD.company_id) THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM public.signing_request_signers s
                WHERE s.signing_request_id = OLD.id AND s.status = 'signed') THEN
      RAISE EXCEPTION 'SIGNING_REQUEST_DELETE_BLOCKED: a request someone signed is evidence and is never deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- What the request is never changes.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_via IS DISTINCT FROM OLD.created_via
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.document_sha256 IS DISTINCT FROM OLD.document_sha256
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.annual_report_version_id IS DISTINCT FROM OLD.annual_report_version_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SIGNING_REQUEST_FROZEN: the document, hash, text and expiry of a signing request never change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'open' THEN
    RETURN NEW;
  END IF;

  -- A closed request takes one more change: the sealed copies, once.
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.declined_at IS DISTINCT FROM OLD.declined_at
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR (OLD.signed_document_id IS NOT NULL AND NEW.signed_document_id IS DISTINCT FROM OLD.signed_document_id)
     OR (OLD.evidence_document_id IS NOT NULL AND NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id) THEN
    RAISE EXCEPTION 'SIGNING_REQUEST_CLOSED: a closed signing request only takes its sealed copies, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signing_requests_guard
  BEFORE UPDATE OR DELETE ON public.signing_requests
  FOR EACH ROW EXECUTE FUNCTION public.signing_requests_guard();

CREATE OR REPLACE FUNCTION public.signing_request_signers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
       AND public.signing_in_sandbox_teardown(OLD.company_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION 'SIGNING_SIGNER_DELETE_BLOCKED: a signature is evidence and is never deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.signing_request_id IS DISTINCT FROM OLD.signing_request_id
     OR NEW.position IS DISTINCT FROM OLD.position
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.role_label IS DISTINCT FROM OLD.role_label
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.lock_kind IS DISTINCT FROM OLD.lock_kind
     OR NEW.annual_report_signature_id IS DISTINCT FROM OLD.annual_report_signature_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_FROZEN: who a signer is never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Signed or declined: the whole row is frozen.
  IF OLD.status IN ('signed', 'declined') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_FINAL: a signed or declined signer never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Only record_signing_signature makes a signature (it sets the flag below).
  IF NEW.status = 'signed' AND OLD.status <> 'signed'
     AND current_setting('gnubok.recording_signature', true) IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'SIGNING_SIGNATURE_RPC_ONLY: a signature is recorded through record_signing_signature'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signing_request_signers_guard
  BEFORE UPDATE OR DELETE ON public.signing_request_signers
  FOR EACH ROW EXECUTE FUNCTION public.signing_request_signers_guard();

CREATE OR REPLACE FUNCTION public.signing_signer_private_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
       AND public.signing_in_sandbox_teardown(OLD.company_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.signature_xml IS NOT NULL THEN
      RAISE EXCEPTION 'SIGNING_SIGNATURE_DELETE_BLOCKED: a signature is evidence and is never deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.signer_id IS DISTINCT FROM OLD.signer_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_FROZEN: private signer data stays with its signer'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.signature_xml IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'SIGNING_SIGNER_FINAL: a recorded signature never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.signature_xml IS NOT NULL
     AND current_setting('gnubok.recording_signature', true) IS DISTINCT FROM NEW.signer_id::text THEN
    RAISE EXCEPTION 'SIGNING_SIGNATURE_RPC_ONLY: a signature is recorded through record_signing_signature'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signing_signer_private_guard
  BEFORE UPDATE OR DELETE ON public.signing_signer_private
  FOR EACH ROW EXECUTE FUNCTION public.signing_signer_private_guard();

-- updated_at runs after the guards (trigger names sort after "signing_").
CREATE TRIGGER zz_set_updated_at_signing_requests
  BEFORE UPDATE ON public.signing_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER zz_set_updated_at_signing_request_signers
  BEFORE UPDATE ON public.signing_request_signers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER zz_set_updated_at_signing_signer_private
  BEFORE UPDATE ON public.signing_signer_private
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_signing_requests
  AFTER INSERT OR UPDATE OR DELETE ON public.signing_requests
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
-- The signers' audit row leaves out what members may not read (the link's
-- token hash, the live BankID session and the poll lease: the column grant
-- below), so audit_log never hands them out. An update that changes only
-- those (a poll lease, about once a second while BankID is open) writes no
-- audit row. Otherwise the shape of write_audit_log's rows.
CREATE OR REPLACE FUNCTION public.signing_signer_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_withheld constant text[] := ARRAY['token_hash', 'bankid_session_id', 'poll_lease_until', 'updated_at'];
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_user_id uuid;
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_old := to_jsonb(OLD) - v_withheld;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := to_jsonb(NEW) - v_withheld;
  END IF;
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NEW;
  END IF;
  v_row := coalesce(v_new, v_old);
  v_user_id := coalesce((v_row->>'user_id')::uuid, auth.uid());
  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, (v_row->>'company_id')::uuid, TG_OP, TG_TABLE_NAME, (v_row->>'id')::uuid, v_user_id, v_old, v_new,
    CASE TG_OP WHEN 'INSERT' THEN 'Created ' WHEN 'UPDATE' THEN 'Updated ' ELSE 'Deleted ' END || TG_TABLE_NAME || ' record',
    coalesce(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_signing_request_signers
  AFTER INSERT OR UPDATE OR DELETE ON public.signing_request_signers
  FOR EACH ROW EXECUTE FUNCTION public.signing_signer_audit();
-- no audit trigger on signing_signer_private: the audit row would copy the
-- signature and the personnummer hash and ciphertext into audit_log.

-- =============================================================================
-- 6. record_signing_signature: the only way a signature is recorded
-- =============================================================================
-- One transaction: lock the request (then the årsredovisning version, so a
-- concurrent supersede waits), check the signer, the session and the lock,
-- consume the BankID session, store the signature, mark the signer signed,
-- fill the årsredovisning slot when there is one, and complete the request on
-- the last signature. Refusals answer {ok:false, code}; any failure rolls the
-- whole thing back, including the session consumption.
--
-- p_evidence: given_name, surname, personnummer_hash (sha256 hex of the
-- signer's personnummer), personnummer_masked, completed_at (TIC),
-- user_visible_data, signature_xml, ocsp_response.

CREATE OR REPLACE FUNCTION public.record_signing_signature(
  p_signer_id uuid,
  p_session_id text,
  p_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_request_id uuid;
  v_request public.signing_requests%ROWTYPE;
  v_signer public.signing_request_signers%ROWTYPE;
  v_private public.signing_signer_private%ROWTYPE;
  v_version_status text;
  v_hash text := p_evidence->>'personnummer_hash';
  v_completed_at timestamptz;
  v_signed_at timestamptz;
  v_remaining integer;
BEGIN
  IF p_session_id IS NULL OR v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$'
     OR nullif(btrim(p_evidence->>'given_name'), '') IS NULL
     OR nullif(btrim(p_evidence->>'surname'), '') IS NULL
     OR nullif(p_evidence->>'user_visible_data', '') IS NULL
     OR nullif(p_evidence->>'signature_xml', '') IS NULL
     OR nullif(p_evidence->>'ocsp_response', '') IS NULL
     OR nullif(p_evidence->>'completed_at', '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_EVIDENCE_INCOMPLETE');
  END IF;
  v_completed_at := (p_evidence->>'completed_at')::timestamptz;

  SELECT s.signing_request_id INTO v_request_id FROM public.signing_request_signers s WHERE s.id = p_signer_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_SIGNER_NOT_FOUND');
  END IF;

  -- Lock order: request, then version, then signer (every writer of a
  -- request's signers takes the request first).
  SELECT * INTO v_request FROM public.signing_requests r WHERE r.id = v_request_id FOR UPDATE;
  IF v_request.status <> 'open' OR v_request.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_REQUEST_CLOSED');
  END IF;

  IF v_request.annual_report_version_id IS NOT NULL THEN
    SELECT v.status INTO v_version_status FROM public.annual_report_versions v
     WHERE v.id = v_request.annual_report_version_id FOR SHARE;
    IF v_version_status IS DISTINCT FROM 'ready_for_signature' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_SUBJECT_CHANGED');
    END IF;
  END IF;

  SELECT * INTO v_signer FROM public.signing_request_signers s WHERE s.id = p_signer_id FOR UPDATE;
  IF v_signer.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_SIGNER_NOT_PENDING');
  END IF;
  IF v_signer.bankid_session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_SESSION_MISMATCH');
  END IF;

  SELECT * INTO v_private FROM public.signing_signer_private p WHERE p.signer_id = p_signer_id FOR UPDATE;
  IF v_signer.lock_kind = 'personnummer'
     AND (v_private.lock_personnummer_hash IS NULL OR v_private.lock_personnummer_hash <> v_hash) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_SIGNER_MISMATCH');
  END IF;
  IF v_signer.lock_kind = 'member' AND NOT EXISTS (
    SELECT 1 FROM public.bankid_identities b
     WHERE b.user_id = v_signer.user_id AND b.personal_number_hash = v_hash
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_SIGNER_MISMATCH');
  END IF;

  -- A BankID session signs once.
  INSERT INTO public.bankid_consumed_sessions (session_id) VALUES (p_session_id)
  ON CONFLICT (session_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIGNING_SESSION_CONSUMED');
  END IF;

  -- TIC's clock may run a moment ahead of the database's.
  v_signed_at := least(v_completed_at, now());

  PERFORM set_config('gnubok.recording_signature', p_signer_id::text, true);

  INSERT INTO public.signing_signer_private AS p (
    signer_id, company_id, bankid_personnummer_hash, personnummer_masked, signature_xml, ocsp_response, bankid_session_id
  ) VALUES (
    p_signer_id, v_signer.company_id, v_hash, nullif(p_evidence->>'personnummer_masked', ''),
    p_evidence->>'signature_xml', p_evidence->>'ocsp_response', p_session_id
  )
  ON CONFLICT (signer_id) DO UPDATE
     SET bankid_personnummer_hash = EXCLUDED.bankid_personnummer_hash,
         personnummer_masked = EXCLUDED.personnummer_masked,
         signature_xml = EXCLUDED.signature_xml,
         ocsp_response = EXCLUDED.ocsp_response,
         bankid_session_id = EXCLUDED.bankid_session_id,
         lock_personnummer_encrypted = NULL;

  UPDATE public.signing_request_signers s
     SET status = 'signed',
         signed_at = v_signed_at,
         bankid_given_name = btrim(p_evidence->>'given_name'),
         bankid_surname = btrim(p_evidence->>'surname'),
         user_visible_data = p_evidence->>'user_visible_data',
         poll_lease_until = NULL,
         last_error_code = NULL
   WHERE s.id = p_signer_id;

  IF v_signer.annual_report_signature_id IS NOT NULL THEN
    UPDATE public.arsredovisning_signature_requests a
       SET status = 'signed',
           signed_at = v_signed_at,
           signing_method = 'bankid',
           evidence_reference = 'receipt:signing/' || v_request.id::text || '/' || p_signer_id::text,
           evidence_recorded_by = v_signer.user_id,
           evidence_recorded_at = now(),
           bankid_signature_data = jsonb_build_object(
             'signing_request_id', v_request.id,
             'signing_signer_id', p_signer_id,
             'given_name', btrim(p_evidence->>'given_name'),
             'surname', btrim(p_evidence->>'surname'),
             'completed_at', v_completed_at,
             'document_sha256', v_request.document_sha256
           )
     WHERE a.id = v_signer.annual_report_signature_id
       AND a.company_id = v_signer.company_id
       AND a.annual_report_version_id = v_request.annual_report_version_id
       AND a.status = 'pending';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGNING_SLOT_NOT_PENDING: the årsredovisning slot is no longer waiting for this signature'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM set_config('gnubok.recording_signature', '', true);

  SELECT count(*) INTO v_remaining FROM public.signing_request_signers s
   WHERE s.signing_request_id = v_request.id AND s.status <> 'signed';
  IF v_remaining = 0 THEN
    UPDATE public.signing_requests r SET status = 'completed', completed_at = now() WHERE r.id = v_request.id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'signing_request_id', v_request.id,
    'signer_id', p_signer_id,
    'signed_at', v_signed_at,
    'completed', v_remaining = 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_signing_signature(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_signing_signature(uuid, text, jsonb) TO service_role;

-- =============================================================================
-- 7. RLS and grants
-- =============================================================================

ALTER TABLE public.signing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signing_request_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signing_signer_private ENABLE ROW LEVEL SECURITY;

-- Members read their company's requests and signers; nobody writes from a
-- browser session (the routes write as the service role after their checks).
CREATE POLICY "signing_requests_select_member" ON public.signing_requests
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "signing_request_signers_select_member" ON public.signing_request_signers
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
-- signing_signer_private: no policy; the service role only.

GRANT SELECT ON TABLE public.signing_requests TO authenticated;
GRANT SELECT (id, company_id, signing_request_id, position, name, email, role_label, user_id, lock_kind,
              annual_report_signature_id, link_sent_at, last_reminded_at, status, bankid_session_started_at,
              signed_at, bankid_given_name, bankid_surname, user_visible_data, declined_at, decline_reason,
              last_error_code, created_at, updated_at)
  ON TABLE public.signing_request_signers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.signing_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.signing_request_signers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.signing_signer_private TO service_role;
-- no-grant: anon on public.signing_requests (the token routes run as the service role; the token is the credential)
-- no-grant: anon on public.signing_request_signers (the token routes run as the service role; the token is the credential)
-- no-grant: anon on public.signing_signer_private (personnummer lock and BankID signatures; service role only)
-- no-grant: authenticated on public.signing_signer_private (personnummer lock and BankID signatures; service role only)

NOTIFY pgrst, 'reload schema';
