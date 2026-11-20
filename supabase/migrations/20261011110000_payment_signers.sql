-- The personnummer a person signs bank payments with, remembered after the
-- bank accepted it once, so the signing step never asks for it again.
--
-- A person with a BankID login already has theirs in bankid_identities; this
-- table serves the person who logs in with email and password and types the
-- number the first time. Encrypted with the same key as bankid_identities
-- (encryptPersonalNumberForStorage); read and written by the service role
-- only, never by a browser session, never on an order.
--
-- pg-test: covered-by tests/pg/payment-signers.pg.test.ts

CREATE TABLE public.payment_signers (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  personal_number_enc text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_signers ENABLE ROW LEVEL SECURITY;
-- No policies: service role only. The revoke keeps anon and authenticated
-- out even if a policy is ever added by mistake.
REVOKE ALL ON TABLE public.payment_signers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_signers TO service_role;

COMMENT ON TABLE public.payment_signers IS
  'The personnummer a person signs bank payments with (encrypted), remembered after the bank accepted it once. Service-role only.';
