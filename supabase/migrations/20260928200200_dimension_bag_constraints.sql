-- Dimension bags: the shape contract moves into the database.
--
-- 1. journal_entry_lines.dimensions: every key a canonical SIE dimension
--    number, every value a registry-shaped object code.
--
--    The column only carried jel_dimensions_is_object (20260702084500), so
--    {"1":null}, {"x":"KS01"}, {"1":5} or {"1":{"a":"b"}} were all storable.
--    The contract lived in application code only: DimensionsBagSchema at the
--    API layer and normalizeLineDimensions in the engine
--    (src/lib/bookkeeping/dimension-resolver.ts). SQL writers insert the bag
--    they are handed: correct_entry_lines_inline (p_new_lines),
--    commit_opening_balance_replacement (p_lines), import_sie_journal_entries
--    and write_sie_job_entries (the chunk payload); retag_line_dimensions
--    validates the TEXT form of each value, so {"1":5} passes it whenever the
--    registry holds the code '5'. A direct PostgREST call to any of them
--    could therefore store a bag no reader expects.
--
--    The CHECK below is that contract, exactly as DimensionsBagSchema and the
--    dimension_values.code CHECK (20260702084500) state it: keys match
--    ^[1-9][0-9]*$, values are JSON strings of 1 to 40 characters with none
--    of `"`, `{`, `}`. {} (untagged, the column default) passes. An empty
--    string never reaches the table: normalizeLineDimensions drops it (''
--    means "clear" to mergeDimensionBags), bulk_book_transactions filters
--    btrim(value) <> '', retag refuses it, and the rättelse, IB and SIE
--    paths build their bags through those same functions or schemas.
--
--    One immutable expression, no helper function: `@?` is
--    jsonb_path_exists_opr (IMMUTABLE). Strict mode plus the operator's
--    error suppression make a non-object yield NULL here, so
--    jel_dimensions_is_object (which sorts first and is checked first) keeps
--    reporting those. flag "s" lets `[^"{}]` match a newline, as the code
--    CHECK does. Cost measured at about 5 microseconds per row, on INSERT and
--    UPDATE only.
--
--    NOT VALID, and deliberately NOT validated here: the coordinator
--    verified prod on 2026-09-28 (353,494 tag pairs, zero violations), and
--    VALIDATE CONSTRAINT would scan every journal line under the migration
--    runner. New and updated rows are checked from now on. On any other
--    database (self-hosted, staging), find the rows the constraint would
--    refuse with:
--      SELECT id FROM public.journal_entry_lines
--       WHERE dimensions @? 'strict $.keyvalue() ? (!(@.key like_regex "^[1-9][0-9]*$") || @.value.type() != "string" || !(@.value like_regex "^[^\"{}]{1,40}$" flag "s"))';
--    Such a row is not rewritten, but a reversal that copies its bag verbatim
--    (storno, undo of an SIE import) would now be refused until it is
--    repaired.
--
--    Behaviour change to know about: an SIE file whose #TRANS object code
--    cannot be registered (over 40 characters, or containing `"`, `{` or
--    `}`) is now refused at the line insert instead of being stored as a tag
--    the registry itself refuses (importDimensionRegistry already skips such
--    codes with a warning). None has reached prod so far.
--
-- 2. sales_orders.default_dimensions and sales_order_items.dimensions get
--    the jsonb_typeof = 'object' CHECK every other producer column has
--    (invoices and supplier invoices 20260702200000, employees
--    20260702220000, recurring schedules 20260729100000, categorization
--    templates 20260729101000); the kundorder migration (20260902130000)
--    left it out. Prod verified by the coordinator: 0 violating rows, 0 NULL.
--    Both tables are small, so the constraints are validated immediately.
--
-- 3. company_settings.dimensions_enabled: the column comment
--    (20260702100000) said the flag is never load-bearing and that data is
--    validated regardless. validateEntryDimensions skips registry validation
--    entirely while the flag is off, and the MCP resolver does the same, so
--    the comment now states what the flag actually gates.
--
-- The journal_entry_lines ALTER takes an ACCESS EXCLUSIVE lock for a
-- catalog-only change; it runs last so that lock is held for the shortest
-- time before commit.
--
-- pg-test: tests/pg/dimensions-substrate.pg.test.ts (line CHECK, comment),
-- tests/pg/dimension-retag.pg.test.ts (CHECK on the retag UPDATE),
-- tests/pg/sales-orders.pg.test.ts (producer CHECKs)

-- =============================================================================
-- 3. company_settings.dimensions_enabled: what the flag really does
-- =============================================================================

COMMENT ON COLUMN public.company_settings.dimensions_enabled IS
  'Per-company dimensions switch (kostnadsställen, projekt). UI: shows the registry, the line pickers and the report filters. Also load-bearing for writes: while true, validateEntryDimensions (src/lib/bookkeeping/dimension-resolver.ts; engine createDraftEntry, updateDraftEntry, replaceOpeningBalanceEntry) and the MCP dimension resolver reject a tag whose dimension is not in the registry or whose code is not an active value of it; while false, tags pass through as free text with no registry check. Not consulted by retag_line_dimensions (always requires active registry values), bulk_book_transactions, reversal/storno/correction or accrual copies, or account_dimension_rules. The bag format (SIE dimension-number keys, 1-40 character codes) is enforced regardless, by the API schema and the jel_dimensions_well_formed CHECK. SIE import that finds dimension data turns it on with a notice.';

-- =============================================================================
-- 2. Producer columns on kundorder
-- =============================================================================

ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_default_dimensions_is_object
  CHECK (jsonb_typeof(default_dimensions) = 'object');

ALTER TABLE public.sales_order_items
  ADD CONSTRAINT sales_order_items_dimensions_is_object
  CHECK (jsonb_typeof(dimensions) = 'object');

-- =============================================================================
-- 1. journal_entry_lines.dimensions: well-formed bags only
-- =============================================================================

ALTER TABLE public.journal_entry_lines
  ADD CONSTRAINT jel_dimensions_well_formed
  CHECK (NOT (dimensions @? 'strict $.keyvalue() ? (!(@.key like_regex "^[1-9][0-9]*$") || @.value.type() != "string" || !(@.value like_regex "^[^\"{}]{1,40}$" flag "s"))'))
  NOT VALID;

COMMENT ON CONSTRAINT jel_dimensions_well_formed ON public.journal_entry_lines IS
  'Dimension bag contract: keys are canonical SIE dimension numbers, values are JSON strings of 1-40 characters without ", { or } (the dimension_values.code CHECK; DimensionsBagSchema in src/lib/bookkeeping/dimension-resolver.ts). {} passes. NOT VALID: prod had zero offending rows on 2026-09-28; rows written since are checked.';

NOTIFY pgrst, 'reload schema';
