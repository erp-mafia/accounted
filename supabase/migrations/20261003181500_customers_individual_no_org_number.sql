-- An individual customer (privatperson) has no org number.
--
-- A privatperson's identifier is its personnummer, stored AES-256-GCM
-- encrypted in personal_number and masked on every read. org_number is
-- plaintext and shown in full on detail surfaces, so a personnummer there is
-- PII in the clear (GDPR art. 5.1 c). The rule lived only in application
-- code, copied into each write path, and the paths that never got a copy
-- (the CSV register import, MCP update_customer) wrote the personnummer to
-- org_number: 150 such rows in production on 2026-10-03. The application
-- fix (every write path moves a personnummer into personal_number and
-- refuses any other value on an individual) makes this state unreachable
-- from the app; this CHECK makes it unreachable, full stop.
--
-- An empty org_number counts as none. The customer form writes '' for every
-- new individual (302 such rows in production on 2026-10-03, newest the same
-- day), and every write path already reads a blank value as "no org
-- number". Refusing '' would break creating a privatperson from the form;
-- normalising it to NULL everywhere is a separate cleanup with no privacy
-- gain.
--
-- NOT VALID, and deliberately no VALIDATE here: a NOT VALID CHECK holds every
-- INSERT and every UPDATE from now on, but does not scan existing rows. The
-- scan would fail in production until
-- scripts/repair-customer-personal-number-in-org-number.ts has run, and on a
-- self-hosted database that never ran it. VALIDATE belongs in a follow-up
-- migration once production is confirmed clean.
--
-- Because the CHECK holds every UPDATE, a row that violates it can no longer
-- be updated at all (not even its email, nor a party_id cleared by ON DELETE
-- SET NULL). That is why this migration ships only after the repair script
-- has run in production.

ALTER TABLE public.customers
  ADD CONSTRAINT customers_individual_no_org_number
  CHECK (customer_type <> 'individual' OR btrim(coalesce(org_number, '')) = '')
  NOT VALID;

COMMENT ON CONSTRAINT customers_individual_no_org_number ON public.customers IS
  'A privatperson has no org number: its personnummer is stored encrypted in personal_number. An empty org_number counts as none. Added NOT VALID; validate once existing rows are repaired.';

NOTIFY pgrst, 'reload schema';
