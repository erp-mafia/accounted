-- Suppliers carry a default dimension bag (accounted#144).
--
--   suppliers.default_dimensions {sie_dim_no: code}, e.g. {"1":"FAST01"}
--
-- A company that tags every cost by kostnadsställe or projekt (one property
-- per supplier, say) tagged each supplier invoice by hand. A new supplier
-- invoice now takes this bag as its own default_dimensions (the column added
-- by 20260702200000) when the request names none: the dashboard and v1
-- create, the Inkorg convert, its one click and register-and-settle, and the
-- MCP gnubok_create_supplier_invoice_from_inbox
-- (src/lib/suppliers/default-dimensions.ts). A bag sent with the invoice,
-- {} included, overrides it. Credit notes copy the invoice they credit, and
-- an invoice registered against a booked verifikat takes the verifikat's
-- tags, so neither reads this column.
--
-- Same shape and CHECKs as the other producer columns: the object CHECK of
-- 20260702200000/20260702220000 and the bag contract of
-- jel_dimensions_well_formed (20260928200200), so a bag no line may carry
-- can never be stored as a default either. The column is new and every row
-- holds '{}', so both constraints are validated at once. NOT NULL DEFAULT
-- '{}' is metadata-only on PG11+ (no rewrite). No index: read through the
-- supplier row, never containment-queried.
--
-- pg-test: tests/pg/supplier-default-dimensions.pg.test.ts

ALTER TABLE public.suppliers
  ADD COLUMN default_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.suppliers
  ADD CONSTRAINT suppliers_default_dimensions_is_object
  CHECK (jsonb_typeof(default_dimensions) = 'object');

ALTER TABLE public.suppliers
  ADD CONSTRAINT suppliers_default_dimensions_well_formed
  CHECK (NOT (default_dimensions @? 'strict $.keyvalue() ? (!(@.key like_regex "^[1-9][0-9]*$") || @.value.type() != "string" || !(@.value like_regex "^[^\"{}]{1,40}$" flag "s"))'));

COMMENT ON COLUMN public.suppliers.default_dimensions IS
  'Dimension bag {sie_dim_no: code} a new supplier invoice from this supplier takes as its default_dimensions when the request sends none ({} sent overrides it). See src/lib/suppliers/default-dimensions.ts.';

NOTIFY pgrst, 'reload schema';
