-- Counterparty templates learn dimension tags from runtime bookings.
--
-- categorization_templates.default_dimensions holds the {sie_dim_no: code}
-- bag the user last booked this counterparty with. The legacy single-line
-- template path applies it to the business line of the next suggested
-- booking (an explicit user-picked bag still wins); multi-line SIE-learned
-- patterns keep carrying per-entry bags in line_pattern and ignore this
-- column by design (per-line bags are authoritative there).
--
-- Update semantics are latest-explicit-wins: a booking WITH a bag replaces
-- the stored bag, a booking without one leaves it untouched (an untagged
-- booking is not evidence the user stopped using dimensions).
--
-- Same shape + CHECK as journal_entry_lines.dimensions (20260702084500).
-- NOT NULL DEFAULT '{}' is metadata-only on PG11+ (no table rewrite).
--
-- pg-test: covered-by — plain column add with a type CHECK, no
-- trigger/RPC/RLS/DEFERRABLE change. Learning/apply logic is TS-side
-- (lib/bookkeeping/counterparty-templates.ts unit tests).

ALTER TABLE public.categorization_templates
  ADD COLUMN default_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.categorization_templates
  ADD CONSTRAINT categorization_templates_default_dimensions_is_object
  CHECK (jsonb_typeof(default_dimensions) = 'object');

COMMENT ON COLUMN public.categorization_templates.default_dimensions IS
  'Dimension bag {sie_dim_no: code} learned from the latest tagged booking of this counterparty; applied to the business line when the template is booked via the legacy single-line path. See lib/bookkeeping/counterparty-templates.ts.';

NOTIFY pgrst, 'reload schema';
