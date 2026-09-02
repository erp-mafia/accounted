-- Peppol participant allowlist per connector key (review follow-up on #2177).
--
-- A hosted company registers the participant its own settings declare, after
-- BankID/TIC-verified onboarding. An instance is only a licensee: nothing on
-- the hosted side knows which organisations it hosts, so without this column a
-- key could publish (and send under) ANY organisation number through Arcim's
-- access point. Arcim records, at issuance, which participant identifiers the
-- licensee may use; the key's own org_number is always allowed.
--
-- pg-test: covered-by tests/pg/connector-proxy-ledger.pg.test.ts
ALTER TABLE public.connector_keys
  ADD COLUMN IF NOT EXISTS peppol_participants text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.connector_keys.peppol_participants IS
  'Participant identifiers (org numbers, GLNs) this key may register and send as through the hosted Peppol access point; the key org_number is implicitly allowed.';

NOTIFY pgrst, 'reload schema';
