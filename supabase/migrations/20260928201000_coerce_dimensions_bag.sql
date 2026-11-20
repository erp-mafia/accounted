-- The SQL twin of coerceDimensionsBag (src/lib/bookkeeping/dimension-resolver.ts):
-- turn a document's stored dimension bag ({sie_dim_no: code}, e.g.
-- invoices.default_dimensions) into the bag a journal line may carry.
--
-- Why it exists: the settlement writers that post inside the database
-- (match_batch_allocate, link_invoice_to_voucher, link_supplier_invoice_to_voucher)
-- must tag their lines with the settled document's bag exactly the way the
-- TypeScript payment generators do (createInvoicePaymentJournalEntry and
-- createSupplierInvoicePaymentEntry stamp coerceDimensionsBag(invoice
-- .default_dimensions) on every leg). One definition here keeps the three
-- SQL writers from each growing their own reading of a bag.
--
-- Same semantics as the TypeScript function, which is the reference:
--   * whole-bag validation against DimensionsBagSchema: every key a canonical
--     SIE dimension number (^[1-9][0-9]*$), every value a string of 1 to 40
--     characters without ", { or }. One invalid entry leaves the WHOLE bag
--     out (tags are never load-bearing for validity, so booking proceeds
--     untagged rather than failing);
--   * normalizeLineDimensions: values trimmed, blank values dropped.
-- Returns '{}' where TypeScript returns undefined, because
-- journal_entry_lines.dimensions is NOT NULL DEFAULT '{}'.
--
-- It reads nothing and writes nothing: IMMUTABLE, SECURITY INVOKER. Account
-- dimension rules (required/default/fixed) are deliberately NOT applied here:
-- they are enforced in TypeScript only (dimension-rules.ts at draft creation
-- and commit), by design, and the SQL writers never consulted them.
--
-- pg-test: covered-by tests/pg/settlement-dimensions.pg.test.ts

CREATE OR REPLACE FUNCTION public.coerce_dimensions_bag(p_bag jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN p_bag IS NULL OR jsonb_typeof(p_bag) <> 'object' THEN '{}'::jsonb
    WHEN EXISTS (
      SELECT 1
      FROM jsonb_each(p_bag) AS e(key, value)
      WHERE e.key !~ '^[1-9][0-9]*$'
         OR jsonb_typeof(e.value) <> 'string'
         OR char_length(e.value #>> '{}') NOT BETWEEN 1 AND 40
         OR (e.value #>> '{}') ~ '["{}]'
    ) THEN '{}'::jsonb
    ELSE COALESCE((
      SELECT jsonb_object_agg(e.key, t.code)
      FROM jsonb_each(p_bag) AS e(key, value)
      CROSS JOIN LATERAL (
        SELECT regexp_replace(e.value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g') AS code
      ) AS t
      WHERE t.code <> ''
    ), '{}'::jsonb)
  END
$function$;

REVOKE ALL ON FUNCTION public.coerce_dimensions_bag(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coerce_dimensions_bag(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.coerce_dimensions_bag(jsonb) IS
  'SQL twin of coerceDimensionsBag (src/lib/bookkeeping/dimension-resolver.ts): the dimension bag a journal line may carry, from a document''s stored bag. Whole-bag validation (keys ^[1-9][0-9]*$, values 1 to 40 characters without ", { or }); an invalid bag yields {}. Values are trimmed and blank values dropped. Returns {} for no tags. Account dimension rules are not applied (TypeScript only, by design).';

NOTIFY pgrst, 'reload schema';
