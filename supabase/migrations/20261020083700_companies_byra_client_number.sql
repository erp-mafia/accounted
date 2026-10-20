SELECT set_config('lock_timeout', '5s', true);

-- The byrå's own customer number for a client company (crm#1279).
-- pg-test: tests/pg/byra-client-number.pg.test.ts
--
-- A byrå keys every client by its own customer number: billing, time
-- reporting, the archive. With no place for it here, the number lived in
-- another system and the Klienter list could not be searched by it.
--
--   byra_client_number
--     Free text as the byrå writes it ("1042", "K-0193"), NULL when unset.
--     Trimmed, 1 to 40 characters, no control characters: the client list
--     shows it on one line. Not unique: a byrå may reuse or share numbers
--     across its own systems, and a duplicate here breaks nothing.
--
-- On companies, next to team_id: a company hangs on one team, and the number
-- is that team's key for it, read in the same row the cockpit already loads.
-- When the company moves to another team (or leaves its byrå) the number goes
-- with the old link: the trigger below clears a carried-over value, so a new
-- byrå never sees, or searches by, the previous byrå's number. An UPDATE that
-- changes team_id AND sets a new number in the same statement keeps the new
-- number.
--
-- Grants: companies keeps table-level privileges (no column-level grants),
-- so the column is readable by every member and writable under the existing
-- companies_update policy (company admins, which team sync makes every byrå
-- owner/admin in each client). The cockpit's write door,
-- PUT /api/clients/:companyId/client-number, narrows that to the byrå's
-- owners and admins for the byrå's own clients.
--
-- The CHECK is added NOT VALID and validated in 20261020083701, in a separate
-- transaction, so this file never scans the table under the ALTER's lock.

ALTER TABLE public.companies
  ADD COLUMN byra_client_number text,
  ADD CONSTRAINT companies_byra_client_number_check CHECK (
    byra_client_number IS NULL
    OR (
      byra_client_number = btrim(byra_client_number)
      AND char_length(byra_client_number) BETWEEN 1 AND 40
      AND byra_client_number !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

COMMENT ON COLUMN public.companies.byra_client_number IS
  'The byrå''s own customer number for this client company (teams.kind = byra). Free text, NULL when unset; cleared when team_id changes.';

CREATE OR REPLACE FUNCTION public.companies_byra_client_number_follows_team()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only a value carried over from the old team is cleared; a number written
  -- in the same statement as the move belongs to the new team.
  IF NEW.byra_client_number IS NOT DISTINCT FROM OLD.byra_client_number THEN
    NEW.byra_client_number := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.companies_byra_client_number_follows_team() IS
  'BEFORE UPDATE OF team_id on companies: clears the previous team''s byra_client_number when the company changes team.';

CREATE TRIGGER companies_byra_client_number_follows_team
  BEFORE UPDATE OF team_id ON public.companies
  FOR EACH ROW
  WHEN (OLD.team_id IS DISTINCT FROM NEW.team_id)
  EXECUTE FUNCTION public.companies_byra_client_number_follows_team();

NOTIFY pgrst, 'reload schema';
