-- Dimensions PR8 (salary): employees carry a default dimension bag so the
-- salary booking can put each employee's cost on their kostnadsställe/projekt.
--
--   employees.default_dimensions {sie_dim_no: code}, e.g. {"1":"KS01"}
--
-- Read at book time by both salary book routes (dashboard + v1) and merged
-- onto the P&L cost lines of the salary/avgifter/semester/pension entries;
-- balance-sheet legs (2710, 1930, 2731, 29xx, 2740, 2514) stay aggregated.
-- Same shape + CHECK as journal_entry_lines.dimensions (20260702084500) and
-- the PR7 producer columns (20260702200000). NOT NULL DEFAULT '{}' is
-- metadata-only on PG11+ (no rewrite). No index: read via the employee row
-- when booking, never containment-queried.
--
-- pg-test: covered-by — plain column add with a type CHECK, no
-- trigger/RPC/RLS/DEFERRABLE change. Propagation logic is TS-side
-- (lib/salary/salary-entries.ts unit tests).

ALTER TABLE public.employees
  ADD COLUMN default_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.employees
  ADD CONSTRAINT employees_default_dimensions_is_object
  CHECK (jsonb_typeof(default_dimensions) = 'object');

COMMENT ON COLUMN public.employees.default_dimensions IS
  'Dimension bag {sie_dim_no: code} applied to the employee''s P&L cost lines when a salary run is booked. See lib/salary/salary-entries.ts.';

NOTIFY pgrst, 'reload schema';
