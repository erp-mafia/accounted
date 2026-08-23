-- Peppol as a connector upstream (WS3, follow-up to 20260820124000; originally drafted 2026-08-23, renumbered to keep versions monotonic).
--
-- Lets a self-hosted instance send/receive Peppol through Arcim's contracted
-- Qvalia Access Point with the SAME shape as bank/skatteverket: a per-company
-- connection quota ("one address" = one active Peppol participant registration)
-- and a global upstream rate budget. The hosted proxy route and the
-- instance-side transport reroute are code (lib/connect + lib/invoices); this
-- migration only extends the storage shape.
--
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
