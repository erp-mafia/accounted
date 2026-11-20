-- signing_signer_private.personnummer_masked: accept the app's one display
-- form of a personnummer beside the form stored so far (crm#1969).
--
-- The Signeringsbevis printed a signer's personnummer as XXXXXXXX-1234 (the
-- birth date hidden, the last four digits shown), the opposite of every
-- other read surface, which shows YYYYMMDD-XXXX (maskPersonnummer,
-- src/lib/invariants/personal-number-shape.ts). This column's CHECK allowed
-- the first form only, and a signature whose mask the CHECK refuses is not
-- recorded at all, so the form could not change in the code alone.
--
-- The CHECK now accepts:
--   - what new signatures store: YYYYMMDD-XXXX, YYMMDD-XXXX for a 10-digit
--     number, XXXXXXXX-XXXX for a value that is neither;
--   - what signatures recorded until now store, X{6,8}-NNNN. Signed rows are
--     evidence and frozen (SIGNING_SIGNER_FINAL), so they keep it.
-- It still refuses a personnummer in clear: one side of the dash is all X.
--
-- Widening only, so validating reads the table once and can fail no row.
-- No function, trigger or policy changes.
--
-- pg-test: covered-by tests/pg/signing-requests.pg.test.ts

-- A signature is recorded through this table: fail the migration job instead
-- of queueing a signer's write behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.signing_signer_private
  DROP CONSTRAINT signing_signer_private_personnummer_masked_check;

ALTER TABLE public.signing_signer_private
  ADD CONSTRAINT signing_signer_private_personnummer_masked_check
  CHECK (
    personnummer_masked IS NULL
    OR personnummer_masked ~ '^([0-9]{8}-X{4}|[0-9]{6}-X{4}|X{8}-X{4}|X{6,8}-[0-9]{4})$'
  ) NOT VALID;

ALTER TABLE public.signing_signer_private
  VALIDATE CONSTRAINT signing_signer_private_personnummer_masked_check;

COMMENT ON COLUMN public.signing_signer_private.personnummer_masked IS
  'The signer''s personnummer as the Signeringsbevis prints it. YYYYMMDD-XXXX (maskPersonnummer) for signatures recorded after this migration; XXXXXXXX-NNNN for the ones recorded before, which keep it: a signed row is frozen.';

NOTIFY pgrst, 'reload schema';
