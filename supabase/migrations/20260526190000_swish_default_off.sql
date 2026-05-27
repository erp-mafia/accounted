-- Make Swish disabled by default. The original migration
-- (20260521120050_company_settings_swish.sql) shipped with DEFAULT true,
-- which meant every company without an explicit choice saw "show Swish"
-- toggled on — even those that had never configured a Swish number.
--
-- Going forward: new rows default to false. Existing rows that never
-- configured a Swish number (swish IS NULL or '') get flipped to false
-- too, since the toggle being on without a number is meaningless. Rows
-- that DO have a Swish number are left alone — those companies
-- presumably want the toggle on.

ALTER TABLE public.company_settings
  ALTER COLUMN invoice_show_swish SET DEFAULT false;

UPDATE public.company_settings
   SET invoice_show_swish = false
 WHERE invoice_show_swish IS NOT FALSE
   AND (swish IS NULL OR swish = '');

NOTIFY pgrst, 'reload schema';
