-- Peppol as a connector upstream (WS3, follow-up to 20260820124000; originally drafted 2026-08-23, renumbered to keep versions monotonic).
--
-- Lets a self-hosted instance send/receive Peppol through Arcim's contracted
-- Qvalia Access Point with the SAME shape as bank/skatteverket: a per-company
-- connection quota ("one address" = one active Peppol participant registration)
-- and a global upstream rate budget. The hosted proxy route and the
-- instance-side transport reroute are code (lib/connect + lib/invoices); this
-- migration only extends the storage shape.
--
-- pg-test: covered-by tests/pg/connector-proxy-ledger.pg.test.ts
-- NOTE: switch-on for real third-party instances is gated on the Qvalia
-- brokering-terms check (brokering Qvalia's AP registers those companies under
-- Arcim's AP). The schema is inert until a connector key carries a peppol scope.

-- 1. Allow 'peppol' in the ownership ledger. The inline CHECK from
--    20260820124000 is auto-named connector_connections_service_check.
ALTER TABLE public.connector_connections
  DROP CONSTRAINT IF EXISTS connector_connections_service_check;
ALTER TABLE public.connector_connections
  ADD CONSTRAINT connector_connections_service_check
  CHECK (service IN ('bank', 'skatteverket', 'peppol'));

-- 2. Add the peppol per-company connection quota to the sellable package shape.
--    "One address" = one active Peppol participant registration per company.
ALTER TABLE public.connector_keys
  ALTER COLUMN limits SET DEFAULT
    '{"bank_connections_per_company": 1, "skv_connections_per_company": 1, "peppol_connections_per_company": 1, "sync_min_interval_s": 0}'::jsonb;

-- Backfill existing keys so the proxy can read the quota without a code fallback.
UPDATE public.connector_keys
  SET limits = limits || '{"peppol_connections_per_company": 1}'::jsonb
  WHERE NOT (limits ? 'peppol_connections_per_company');

-- 3. Ownership of outbound submissions made through the connector. The hosted
--    Qvalia account is shared by every hosted company and every instance, so
--    status polls and evidence retrieval must prove the caller submitted the
--    document. Secret-free: the provider submission id is a provider-side
--    handle, not a credential. Service-role only, like the ledger.
CREATE TABLE public.connector_peppol_submissions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key_id        uuid NOT NULL REFERENCES public.connector_keys(id) ON DELETE CASCADE,
  company_ref             text NOT NULL,
  provider                text NOT NULL DEFAULT 'qvalia',
  provider_submission_id  text NOT NULL CHECK (length(btrim(provider_submission_id)) BETWEEN 1 AND 128),
  idempotency_key         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_peppol_submissions_provider_submission_unique UNIQUE (provider, provider_submission_id)
);
CREATE INDEX idx_connector_peppol_submissions_key
  ON public.connector_peppol_submissions (connector_key_id, created_at DESC);
ALTER TABLE public.connector_peppol_submissions ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (same posture as connector_connections).
COMMENT ON TABLE public.connector_peppol_submissions IS
  'Which connector key submitted which Peppol document through the shared hosted access point; gates status/evidence reads. No secrets.';

NOTIFY pgrst, 'reload schema';
