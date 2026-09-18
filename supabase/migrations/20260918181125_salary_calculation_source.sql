-- Do not infer provenance from a wage type: operators can enter the same type.
ALTER TABLE public.salary_line_items
  ADD COLUMN calculation_source text
  CHECK (calculation_source IS NULL OR calculation_source = 'vacation_compensation');
COMMENT ON COLUMN public.salary_line_items.calculation_source IS
  'Engine-owned provenance. NULL denotes a manually entered or unclassified legacy row.';
NOTIFY pgrst, 'reload schema';
