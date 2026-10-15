-- One company name: company_settings.company_name, mirrored onto
-- companies.name on every write (crm#1209).
--
-- Why this exists: the company's name is stored twice. companies.name is
-- written once, when the company row is created (create_company_with_owner,
-- create_company_for_user, the migration reset's replacement row), and no
-- code path ever updated it again. company_settings.company_name is what
-- Inställningar edits and what the invoice PDF prints. A rename therefore
-- only reached the readers that had been patched one at a time to prefer the
-- settings copy (switcher, client list, getCompanyDisplayName); every other
-- reader kept the old name: the company inbox address
-- (auto_provision_company_inbox and rotate_company_inbox slug
-- companies.name, so "Skapa ny inkorgsadress" minted the old name again),
-- payslips, AGI, payment files, bokslutsbilagor, systemdokumentation, agent
-- briefings. Prod 2026-10-15 (read-only): 51 non-archived companies carry a
-- settings name that differs from companies.name, every one with an active
-- inbox; 36 more are archived.
--
-- The settings copy is written from many doors (PUT /api/settings, the v1
-- settings operation and its MCP tool, company creation, the provider
-- migration's company-info fill, the sandbox seed, the migration reset's
-- settings copy), so the mirror lives here, once, instead of in each door.
--
-- 1. sync_company_name_from_settings(): AFTER INSERT OR UPDATE OF
--    company_name on company_settings. A non-blank settings name is copied
--    onto companies.name when they differ; a blank or NULL settings name
--    leaves companies.name alone (it is NOT NULL and the readers fall back to
--    it). It does not compare OLD and NEW, so any save that carries the name
--    also heals a row that had drifted. SECURITY DEFINER: the caller has
--    already passed company_settings' own write gate (owner/admin under RLS,
--    or the service role) for this very company, and the mirror must not
--    depend on a second RLS check on companies. A migration reset source can
--    never reach it: company_settings_block_migration_reset_source_mutation
--    refuses the settings write first.
-- 2. Backfill, once: non-archived companies whose non-blank settings name
--    differs from companies.name get the settings name. Archived companies
--    and migration reset sources (immutable, zz_companies_block_migration_
--    reset_source_mutation) are left alone.
--
-- The inbox address is NOT changed, here or by the trigger: auto-provisioning
-- runs on companies INSERT only, and the address stays what suppliers and
-- forwarding rules send to. A company that wants an address with its current
-- name creates one under Underlag (rotate_company_inbox), which now slugs the
-- synced name.
--
-- pg-test: tests/pg/company-name-sync.pg.test.ts

-- =============================================================================
-- 1. The mirror.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_company_name_from_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.company_name IS NULL OR btrim(NEW.company_name) = '' THEN
    RETURN NEW;
  END IF;

  UPDATE public.companies
  SET name = NEW.company_name
  WHERE id = NEW.company_id
    AND name IS DISTINCT FROM NEW.company_name;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_company_name_from_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS company_settings_sync_company_name ON public.company_settings;
CREATE TRIGGER company_settings_sync_company_name
  AFTER INSERT OR UPDATE OF company_name ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.sync_company_name_from_settings();

-- =============================================================================
-- 2. Backfill.
-- =============================================================================

-- backfill:begin
UPDATE public.companies c
SET name = s.company_name
FROM public.company_settings s
WHERE s.company_id = c.id
  AND c.archived_at IS NULL
  AND s.company_name IS NOT NULL
  AND btrim(s.company_name) <> ''
  AND c.name IS DISTINCT FROM s.company_name
  AND NOT EXISTS (
    SELECT 1 FROM public.company_migration_resets r
    WHERE r.source_company_id = c.id
  );
-- backfill:end
