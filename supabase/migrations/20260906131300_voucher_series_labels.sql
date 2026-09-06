-- Migration: Company-defined names for verifikationsserier
--
-- The series pickers show a fixed Swedish preset label next to each letter
-- (A Redovisning, B Kundfakturor, ...). Those presets follow Fortnox's
-- layout; a byrå that lays its series out differently (L for löner instead
-- of K, say) sees a wrong or missing name in every dropdown. This column
-- lets a company name each letter itself. Display only: the booking engine
-- never reads it, and the letter stays the identifier on journal_entries.
--
-- Keys are single uppercase letters A-Z, values trimmed strings of 1 to 40
-- characters. Validated by UpdateSettingsSchema (lib/api/schemas.ts); the
-- CHECK below only guards the JSON shape so a raw write cannot store an
-- array or scalar that the resolver would then choke on.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS voucher_series_labels JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_voucher_series_labels_object;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_voucher_series_labels_object
  CHECK (jsonb_typeof(voucher_series_labels) = 'object');

COMMENT ON COLUMN public.company_settings.voucher_series_labels IS
  'Company-defined display names per verifikationsserie letter: {"L": "Lön"}. Keys A-Z, values 1-40 chars. Falls back to VOUCHER_SERIES_PRESETS in lib/bookkeeping/voucher-series-resolver.ts. Display only; never read by the booking engine.';

NOTIFY pgrst, 'reload schema';
