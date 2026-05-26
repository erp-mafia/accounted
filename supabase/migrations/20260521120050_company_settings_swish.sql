-- Add Swish as an invoice payment method.
-- Mirrors invoice_show_bankgiro / invoice_show_plusgiro from 20260401200000.
-- swish accepts either a Swish-företag/handel number (1230000000–1239999999)
-- or a Swedish mobile (07X). Validation is enforced in lib/api/schemas.ts;
-- the column is plain text so historical/unusual values remain accepted.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS swish text,
  ADD COLUMN IF NOT EXISTS invoice_show_swish boolean DEFAULT true;

NOTIFY pgrst, 'reload schema';
