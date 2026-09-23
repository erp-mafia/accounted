-- Migration: DB-level shape rules for company_settings.voucher_series_labels
--
-- 20260906131300 added the column with a CHECK that it is a JSON object; the
-- key and value rules (single uppercase letter A-Z, name of 1 to 40 characters)
-- lived only in UpdateSettingsSchema. A write that bypasses /api/settings (an
-- admin script, a backfill, a future service-role path) could therefore store
-- a map the pickers were never designed for. This mirrors the Zod rules in
-- the database so processing integrity does not depend on one route.
--
-- The function is IMMUTABLE and STRICT so it can back a CHECK constraint; a
-- NULL map never reaches it because the column is NOT NULL.

CREATE OR REPLACE FUNCTION public.voucher_series_labels_valid(labels JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT jsonb_typeof(labels) = 'object'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(labels) AS entry(key, value)
      WHERE entry.key !~ '^[A-Z]$'
         OR jsonb_typeof(entry.value) <> 'string'
         OR length(btrim(entry.value #>> '{}')) < 1
         OR length(entry.value #>> '{}') > 40
    );
$$;

COMMENT ON FUNCTION public.voucher_series_labels_valid(JSONB) IS
  'Shape rule for company_settings.voucher_series_labels: object whose keys are single uppercase letters and whose values are non-blank strings of at most 40 characters. Mirrors UpdateSettingsSchema.';

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_voucher_series_labels_object;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_voucher_series_labels_valid;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_voucher_series_labels_valid
  CHECK (public.voucher_series_labels_valid(voucher_series_labels));

NOTIFY pgrst, 'reload schema';
