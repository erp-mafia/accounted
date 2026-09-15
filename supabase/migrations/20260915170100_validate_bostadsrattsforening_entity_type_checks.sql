-- =============================================================================
-- Validate the entity_type CHECK constraints re-added NOT VALID by
-- 20260915170000_bostadsrattsforening_foundation.sql. VALIDATE CONSTRAINT scans
-- under SHARE UPDATE EXCLUSIVE, so concurrent writes keep flowing; it runs in
-- its own migration so the ACCESS EXCLUSIVE lock of the ADD CONSTRAINT above
-- has been released before the scan starts. Every existing row already
-- satisfies the wider allow-list, so this cannot fail on data.
-- =============================================================================

ALTER TABLE public.companies
  VALIDATE CONSTRAINT companies_entity_type_check;

ALTER TABLE public.company_settings
  VALIDATE CONSTRAINT company_settings_entity_type_check;

ALTER TABLE public.booking_template_library
  VALIDATE CONSTRAINT booking_template_library_entity_type_check;
