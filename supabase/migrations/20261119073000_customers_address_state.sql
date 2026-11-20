-- State or province on the customer card.
--
-- customers.address_state: the state or province of a US or Canadian
-- address ('WA', 'ON'). The invoice prints such an address "City, ST ZIP"
-- (src/lib/invoices/postal-address.ts); every other address keeps
-- "postnummer ort". The customer form asks for it only when the country is US
-- or CA; the API and the MCP customer tools take it next to the other address
-- fields.
--
-- NULL for every existing customer and nothing is backfilled: no invoice
-- changes until someone fills the field in.
--
-- A column on an existing table: the table's RLS policies and grants cover it.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS address_state text;

COMMENT ON COLUMN public.customers.address_state IS
  'State or province of a US or Canadian address (e.g. WA). Printed "City, ST ZIP" on the invoice (src/lib/invoices/postal-address.ts).';

NOTIFY pgrst, 'reload schema';
