-- Leveransadress per invoice (crm#1547): where the goods go when that is not
-- the customer's invoice address. One jsonb object
-- { name, address_line1, address_line2, postal_code, city, country }, shaped
-- and validated by lib/invoices/delivery-address.ts; NULL = none.
--
-- Printed on the PDF under "Leveransadress" and sent to Peppol as BG-13
-- Delivery information. Not a mandatory invoice field (ML 17 kap 24 §) and
-- not read by bookkeeping: the VAT treatment of goods sent abroad stays with
-- invoices.delivery_country.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS delivery_address JSONB;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_delivery_address_object_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_delivery_address_object_check
  CHECK (delivery_address IS NULL OR jsonb_typeof(delivery_address) = 'object');

COMMENT ON COLUMN public.invoices.delivery_address IS
  'Leveransadress: {name, address_line1, address_line2, postal_code, city, country}, NULL = none. Printed on the PDF and mapped to Peppol BG-13; informational, VAT follows delivery_country.';

NOTIFY pgrst, 'reload schema';
